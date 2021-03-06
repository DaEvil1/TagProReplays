var $ = require('jquery');
var async = require('async');
var Dexie = require('dexie');
var EventEmitter = require('events');

var convert = require('./convert');
var fs = require('./filesystem');
var Constraints = require('./constraints');
var Util = require('./util');

/**
 * This module has utilities for working with the replay data, and
 * provides an interface on top of the IndexedDB and FileSystem storage
 * services.
 *
 * Everywhere a replay id is needed, it refers to the replay info id.
 * @module Data
 */

/**
 * @fires "db:upgrade"
 * @fires "db:upgrade:progress" - {total, progress}
 * @fires "db:open"
 * @fires "db:err" - {reason}
 * @fires "db:err:upgrade" - {reason}
 */
var bus = exports.events = new EventEmitter();

var db = new Dexie("ReplayDatabase");

exports.db = db;

// Logging.
var events = ["ready", "error", "populate", "blocked", "versionchange"];
events.forEach(function (e) {
    db.on(e, function () {
        console.log("Dexie: %s", e);
    });
});

db.on("blocked", function () {
    bus.emit("db:err", "blocked");
});

// Hold upgrade information until version is decided by Data.init.
var version_holder = {
    version: function (version) {
        console.log("Adding version: " + version);
        var o = {
            version: version
        };
        this._versions.push(o);
        this._max_version = Math.max(version, this._max_version);
        console.log("Total versions added: " + this._versions.length);
        return {
            stores: function (defs) {
                o.stores = defs;
                return this;
            },
            upgrade: function (callback) {
                o.upgrade = callback;
                return this;
            }
        };
    },
    _versions: [],
    _max_version: 0,
    init: function (db, version) {
        if (!version) {
            version = this._max_version;
        }
        console.log("Initializing with versions <= " + version);
        var versions = this._versions.filter(function (o) {
            return o.version <= version;
        });
        console.log("Versions selected: " + versions.length);
        versions.forEach(function (o) {
            db.version(o.version)
              .stores(o.stores)
              .upgrade(o.upgrade);
        });
    }
};

// Initial versions of the database may be either 1 or 2 with
// a 'positions' object store and an empty 'savedMovies' object
// store.
version_holder.version(0.1).stores({
    positions: '',
    savedMovies: ''
});

version_holder.version(0.2).stores({
    positions: '',
    savedMovies: ''
});

// Batch process for a table.
function batch_process(table, batch_size, iteratee) {
    var total;
    // start - position in table to start.
    // returns promise
    function inner_loop(start) {
        console.log(`Executing inner loop on ${start}`);
        // Index of the end of this sequence of items.
        var n = Math.min(batch_size, total - start);
        // whether this is the last iteration.
        var last = start + batch_size >= total;
        return new Dexie.Promise(function inner_loop_promise(resolve, reject) {
            var dones = 0;
            var looped = false; 
            function check(err) {
                // check looped to ensure that the table looping
                // is complete.
                // or is that redundant with checking n?
                if (dones === n && looped) {
                    // reject only when looped?
                    if (err) {
                        reject(err);
                    } else if (!last) {
                        // recurse
                        resolve(inner_loop(start + n));
                    } else {
                        // done
                        resolve();
                    }
                }
            }
            
            table.offset(start)
                   .limit(n)
                 .each(function iteratee_caller(item, cursor) {
                var data = {
                    key: cursor.key,
                    value: item
                }; 
                iteratee(data).then(function iteratee_callback(err) {
                    dones++;
                    check(err);
                });
            }).then(function inner_loop_callback() {
                looped = true;
                // check here in case this finishes after each of the individual transactions.
                // e.g. if everything of the transactions are synchronous.
                check();
            });
        });
    }

    return table.count().then(function (t) {
        if (!t) {
            return Dexie.Promise.resolve();
        } else {
            total = t;
            return inner_loop(0);
        }
    });
}

// Current version.
version_holder.version(3).stores({
    info: '++id,&replay_id,name,rendered,duration,dateRecorded',
    replay: '++id,&info_id',
    failed_info: '++id,&replay_id',
    failed_replays: '++id,&info_id',
    positions: null,
    savedMovies: null
}).upgrade(function upgrade_3(trans) {
    console.log("Doing upgrade.");
    // TODO: Error transition if too big.
    // Set upgrading status.
    bus.emit("db:upgrade");

    trans.on('complete', function () {
        console.log("Transaction completed.");
    });

    trans.on('abort', function (err) {
        console.warn("Inside transaction abort handler");
        bus.emit("db:err:upgrade", err);
    });

    trans.on('error', function (err) {
        console.warn("Inside transaction error handler.");
        bus.emit("db:err:upgrade", err);
    });

    // Num done.
    var numberDone = 0;
    // Item #.
    var n = 0;

    // Worker processes replay conversions.
    // Handles one replay at a time.
    // - converts
    // - adds info
    // - adds replay
    // - adds info with replay id 
    function worker(data) {
        // Skip null values.
        if (data.value === null) {
            console.log("Skipping null value.");
            return Dexie.Promise.resolve();
        }

        var name = data.key;
        var item = data.value;
        var i = n++;

        console.log(`Iterating item: ${i}`); // DEBUG
        try {
            var data = convert({
                name: name,
                data: JSON.parse(item)
            });
        } catch(e) {
            // Problem with conversion.
            console.log(`Failed replay: ${i}.`); // DEBUG
            // Catch replay conversion or save error.
            console.warn("Couldn't convert %s due to: %O.", name, e); // DEBUG
            console.log(`Saving ${name} to failed replay database.`); // DEBUG
            var failedInfo = {
                name: name,
                failure_type: "upgrade_error",
                timestamp: Date.now(),
                message: e.message
            };
            return trans.table("failed_info")
                          .add(failedInfo)
                        .then(info_id => {
                console.log(`Added failed info: ${i}.`); // DEBUG
                return {
                    info_id: info_id,
                    name: name,
                    data: item
                };
            }).then(failedReplay => {
                return trans.table("failed_replays")
                              .add(failedReplay);
            }).then(replay_id => {
                console.log(`Added failed replay: ${i}.`); // DEBUG
                return trans.table("failed_info")
                              .update(info_id, {
                                  replay_id: replay_id
                              });
            }).then(() => {
                bus.emit("db:upgrade:progress", {
                    total: total,
                    progress: ++numberDone
                });
                console.log(`Saved failed replay: ${i} (${numberDone}).`); // DEBUG
                callback();
            }).catch(function (err) {
                // TODO: Necessary?
                // Save error, abort transaction.
                console.error("Aborting upgrade due to database error: %O.", err);
                trans.abort();
                throw new Error("error: " + err);
            });
        }
        // Save converted replay.
        var replay = data.data;
        var info = generateReplayInfo(replay);
        // Errors here would bubble up to the transaction.
        console.log(`Adding info: ${i}`);
        return trans.table("info")
                      .add(info)
                    .then(function w_info_add_1(info_id) {
            //debugger;
            console.log(`Added info: ${i}`); // DEBUG
            replay.info_id = info_id;
            return trans.table("replay").add(replay);
        }).then(function w_replay_add(replay_id) {
            console.log(`Added replay: ${i}`); // DEBUG
            info.replay_id = replay_id;
            return trans.table("info").update(replay.info_id, {
                replay_id: replay_id
            });
        }).then(function w_info_add_2() {
            // Console alert that replay was saved, progress update.
            bus.emit("db:upgrade:progress", {
                total: total,
                progress: ++numberDone
            });
            console.log(`Finished replay: ${i} (${numberDone}).`); // DEBUG
        });
    }

    trans.table("positions").count().then(function (t) {
        if (t > Constraints.max_replays_in_database) {
            // TODO: Set error message somehow
            // set("db_full")
            console.error("Aborting upgrade due to database size (replays: %d, max: %d).",
                t, Constraints.max_replays_in_database);
            trans.abort();
        } else if (t === 0) {
            console.log("Empty database, nothing to do.");
        } else {
            console.log(`Database has ${t} replays to upgrade.`);
            total = t;
            var num_workers = 5;
            batch_process(trans.table("positions"),
                num_workers, worker);
        }
    });
});

/**
 * Call to initialize database.
 * @param {number} [version] - Version of database to use, only for
 *   testing.
 * @param {bool} [events] - Whether to emit events for this init call.
 * @return {Promise} - Promise that resolves on open or rejects on open
 *   error.
 */
exports.init = function(version, events) {
    if (typeof events === "undefined") {
        events = true;
    }
    console.log("In Data#init");
    version_holder.init(db, version);
    return db.open().then(function () {
        if (events) {
            console.log("Emitting db:open");
            bus.emit("db:open");
        }
    }).catch(function (err) {
        console.error("Error opening database: %O.", err);
        if (events)
            bus.emit("db:err", "unknown");
        // Re-throw.
        throw err;
    });
};

/**
 * Generates the replay metadata that is stored in a separate object
 * store.
 * @param {Replay} replay - The replay to generate information for.
 * @return {ReplayInfo} - The information for the replay.
 */
function generateReplayInfo(replay) {
    // Copy replay information.
    // Add player information.
    // Add duration.
    var info = Util.clone(replay.info);
    info.duration = Math.round(
        (1e3 / info.fps) * replay.data.time.length);
    info.players = {};
    // Get player information.
    Object.keys(replay.data.players).forEach(function(id) {
        var player = replay.data.players[id];
        info.players[id] = {
            name: Util.find(player.name,
                function(v) { return v !== null; }),
            team: Util.find(player.team,
                function(v) { return v !== null; }),
            id: player.id
        };
    });
    info.rendered = false;
    info.render_id = null;
    info.rendering = false;
    return info;
}

/**
 * Crops a replay to the given start and end frames.
 * @param {Replay} replay - The replay to crop
 * @param {integer} startFrame - The frame to use for the start of the
 *   new replay.
 * @param {integer} endFrame - The frame to use for the end of the new
 *   replay.
 * @return {Replay} - The cropped replay.
 */
function cropReplay(replay, startFrame, endFrame) {
    // Don't do anything if this replay is already the correct size.
    if (startFrame === 0 && endFrame === replay.data.time.length)
        return replay;

    var startTime = replay.data.time[startFrame],
        endTime = replay.data.time[endFrame];

    // Crop an array that only contains information for each frame
    // and impacts no later.
    function cropFrameArray(ary) {
        return ary.slice(startFrame, endFrame + 1);
    }

    // Remove events from provided array that occur after the end
    // of the cropped replay, or far enough in advance of the start
    // that they are not relevant.
    function cropEventArray(ary, cutoff) {
        if (typeof cutoff == "undefined") cutoff = null;
        return ary.filter(function(event) {
            return event.time < endTime && (cutoff === null || startTime - event.time < cutoff);
        });
    }

    // Crop the arrays for a player, returning the player or null
    // if this results in the player no longer being relevant.
    function cropPlayer(player) {
        var name = cropFrameArray(player.name);
        var valid = name.some(function(val) {
            return val !== null;
        });
        if (!valid) return null;
        var newPlayer = {
            auth: cropFrameArray(player.auth),
            bomb: cropFrameArray(player.bomb),
            dead: cropFrameArray(player.dead),
            degree: cropFrameArray(player.degree),
            draw: cropFrameArray(player.draw),
            flag: cropFrameArray(player.flag),
            // Necessary to clone?
            flair: cropFrameArray(player.flair).map(Util.clone),
            grip: cropFrameArray(player.grip),
            id: player.id,
            name: name,
            tagpro: cropFrameArray(player.tagpro),
            team: cropFrameArray(player.team),
            x: cropFrameArray(player.x),
            y: cropFrameArray(player.y)
        };
        if (player.hasOwnProperty("angle")) {
            newPlayer.angle = cropFrameArray(player.angle);
        }
        return newPlayer;
    }

    // Return a dynamic tile with its value array cropped.
    function cropDynamicTile(tile) {
        return {
            x: tile.x,
            y: tile.y,
            value: cropFrameArray(tile.value)
        };
    }

    // Crop array of spawns, taking into account the waiting period
    // for the cutoff.
    function cropSpawns(spawns) {
        return spawns.filter(function(spawn) {
            return spawn.time <= endTime && startTime - spawn.time <= spawn.wait;
        }).map(Util.clone);
    }

    // New, cropped replay.
    var newReplay = {
        info: Util.clone(replay.info),
        data: {
            bombs: cropEventArray(replay.data.bombs, 200),
            chat: cropEventArray(replay.data.chat, 3e4),
            dynamicTiles: replay.data.dynamicTiles.map(cropDynamicTile),
            endTimes: replay.data.endTimes.filter(function(time) {
                return time >= startTime;
            }),
            map: Util.clone(replay.data.map),
            players: {},
            // necessary to clone?
            score: cropFrameArray(replay.data.score).map(Util.clone), 
            spawns: cropSpawns(replay.data.spawns),
            splats: cropEventArray(replay.data.splats),
            time: cropFrameArray(replay.data.time),
            wallMap: Util.clone(replay.data.wallMap)
        },
        version: "2"
    };

    var gameEnd = replay.data.gameEnd;
    if (gameEnd && gameEnd.time <= endTime) {
        newReplay.data.gameEnd = Util.clone(gameEnd);
    }

    // Crop player properties.
    $.each(replay.data.players, function(id, player) {
        var newPlayer = cropPlayer(player);
        if (newPlayer !== null) {
            newReplay.data.players[id] = newPlayer;
        }
    });

    return newReplay;
}

exports.util = {
    cropReplay: cropReplay
};

// Reset the database, for debugging.
exports.resetDatabase = function() {
    db.delete();
};

// Reset the file system, for debugging.
exports.resetFileSystem = function() {

};

// Remove database-specific information from replays.
function cleanReplay(replay) {
    delete replay.id;
    delete replay.info_id;
    return replay;
}

function getReplayDatabaseInfo() {
    return db.info.count().then(function (n) {
        return new Promise(function (resolve, reject) {
            navigator.webkitTemporaryStorage
                     .queryUsageAndQuota(function (used) {
                resolve({
                    replays: n,
                    size: used
                });
            });
        });
    });
}
exports.getDatabaseInfo = getReplayDatabaseInfo;

/**
 * @typedef CropRequest
 * @typedef {object}
 * @property {integer} id - The id of the replay to crop.
 * @property {integer} start - The start frame for the new replay.
 * @property {integer} end - The end frame for the new replay.
 * @property {string} [name] - The new name for the replay. If blank, then
 *   a name is made using the name of the replay being cropped + 
 *   " (cropped)".
 */
/**
 * Crop a replay and save it with a new name.
 * @param {CropRequest} info - The information for the cropping.
 * @return {Promise} - Promise object that resolves to a tuple of the form
 *   [replayInfo, replay].
 */
function cropAndSaveReplayAs(request) {
    if (request.name === "") request.name = false;
    return db.transaction("rw", db.info, db.replay, function() {
        return db.replay
                   .where("info_id")
                   .equals(request.id)
                   .first()
                 .then(function (replay) {
            var name = request.name ? request.name : replay.info.name + " (cropped)";
            // TODO: Ensure within bounds of replay and doesn't result in a length 0 replay.
            replay = cropReplay(replay, request.start, request.end);
            replay.info.name = name;
            return saveReplay(replay).then(function (replayInfo) {
                return [replayInfo, replay];
            });
        });
    }).then(function (data) {
        return [data[0], cleanReplay(data[1])];
    });
}
exports.cropAndSaveReplayAs = cropAndSaveReplayAs;

/**
 * Crop a replay and overwrite it.
 * @param {CropRequest} info - The information for the cropping.
 * @return {Promise} - Promise object that resolves to the new replay.
 */
exports.cropAndSaveReplay = function(request) {
    return db.transaction("rw", db.info, db.replay, function() {
        return cropAndSaveReplayAs(request).then(function (data) {
            // Delete original replay.
            return deleteReplays([request.id]).then(function () {
                return data;
            });
        });
    });
};

/**
 * Retrieve the data corresponding to the given replay.
 * @param {integer} id - The info id of the replay to retrieve.
 * @return {Promise} - Promise that resolves to the replay data, or
 *   rejects if the replay is not present or another error occurs.
 */
exports.getReplay = function(id) {
    return db.replay
               .where("info_id")
               .equals(id)
               .first()
             .then(function (replay) {
        if (replay)
            return cleanReplay(replay);

        throw new Error("No replay found.");
    });
};

/**
 * Iterate over each replay.
 * @param {Arrray.<integer>} ids - Array of ids for the replays to
 *   iterate over.
 * @param {Function} callback - Callback function that receives each of
 *   the replays in turn.
 * @returns {Promise} - Promise that resolves when the iteration is
 *   complete.
 */
exports.forEachReplay = function(ids, callback) {
    return db.replay
               .where("info_id")
               .anyOf(ids)
             .each(function (replay) {
        callback(cleanReplay(replay));
    });
};

/**
 * Get list of replay info for population to menu.
 * @returns {Promise} callback - Promise that resolves to an array of
 *   the replay info, or rejects if an error occurred.
 */
exports.getAllReplayInfo = function() {
    return db.info.toArray();
};

/**
 * @typedef {object} ReplaySelector
 * @property {number} length - The number of replays to select.
 * @property {string} dir - The direction the replays should be sorted
 *   by.
 * @property {number} start - The offset of the replays from the start
 *   of the sorted list.
 * @property {string} sortedBy - String value referencing an indexed
 *   column in the replays object store. Can be one of "name", "date",
 *   "rendered", or "duration".
 */
/**
 * Retrieve information for a subset of replays.
 * @param {ReplaySelector} data - Information on which replays to
 *   select.
 * @returns {Promise} - Promise that resolves to an array with the number
 *   of total replays and the replays that were retrieved.
 */
exports.getReplayInfoList = function(data) {
    var mapped = {
        "name": "name",
        "date": "dateRecorded",
        "rendered": "rendered",
        "duration": "duration"
    };
    var index = mapped[data.sortedBy];
    var collection = db.info.orderBy(index);
    if (data.dir !== "asc") {
        collection.reverse();
    }

    return collection.count().then(function (n) {
        return collection
                 .offset(data.start)
                 .limit(data.length)
                 .toArray()
               .then(function (results) {
            return [n, results];
        });
    });
};

/**
 * Update the info for a single replay with the provided values.
 * @param {number} id - The id of the replay info to update.
 * @param {object} update - The update used for the replay info.
 * @returns {Promise} - Promise that rejects on error.
 */
exports.updateReplayInfo = function(id, update) {
    // Not allowed to set these.
    var protectedKeys = ["id", "replay_id", "info_id"];
    // These are only set on the info object.
    var dbInfoOnly = ["rendered", "renderId", "players", "duration", "rendering"];

    var keys = Object.keys(update);
    // Ensure no protected keys are set.
    var protectedKeyWrite = keys.some(function (key) {
        return protectedKeys.indexOf(key) !== -1;
    });
    if (protectedKeyWrite)
        return Promise.reject("Cannot write to protected keys!");

    // Object keys that apply to the replay.
    var replayKeys = keys.filter(function(key) {
        return dbInfoOnly.indexOf(key) === -1;
    });

    return db.transaction("rw", db.info, db.replay, function () {
        db.info.update(id, update);
        if (replayKeys.length !== 0) {
            var replayObj = {};
            // Construct update object for info property.
            replayKeys.forEach(function (key) {
                replayObj["info." + key] = update[key];
            });
            db.replay.where("info_id").equals(id).modify(replayObj);
        }
    });
};

/**
 * Saves the replay with the given info and replay values.
 * @param {ReplayInfo} [info] - The info for the replay. If not
 *   provided then it will be generated.
 * @param {Replay} replay - The Replay data.
 * @returns {Promise} - Promise that resolves to the info corresponding
 *   to the replay.
 */
function saveReplay(info, replay) {
    if (typeof replay == "undefined") {
        replay = info;
        info = generateReplayInfo(replay);
    }
    return db.transaction("rw", db.info, db.replay, function() {
        return db.info.add(info).then(function (info_id) {
            info.id = info_id;
            replay.info_id = info_id;
            return db.replay.add(replay).then(function (replay_id) {
                info.replay_id = replay_id;
                db.info.update(info_id, { replay_id: replay_id });
                return info;
            });
        });
    });
}
exports.saveReplay = saveReplay;

/**
 * Rename a replay.
 * @param {number} id - The id of the info object for the replay to
 *   rename.
 * @param {string} name - A non-empty string to rename the replay to.
 * @returns {Promise} - Promise that resolves on successful completion,
 *   or rejects if there was an error.
 */
exports.renameReplay = function(id, name) {
    if (name === "") return Promise.reject("Name cannot be blank.");
    return db.transaction("rw", db.info, db.replay, function() {
        db.info.update(id, { name: name });
        db.replay.where("info_id").equals(id).modify({
            "info.name": name
        });
    });
};

/**
 * Delete replay data, includes the info and raw replay as well as the
 * rendered video, if present.
 * @param {Array.<integer>} ids - The ids of the replays to delete
 * @returns {Promise} - Promise that resolves when all ids have been
 *   deleted properly, or rejects on error.
 */
function deleteReplays(ids) {
    return db.transaction("rw", db.info, db.replay, function() {
        return Promise.all(ids.map(function (id) {
            return db.info.get(id).then(function (info) {
                db.info.delete(id);
                db.replay.delete(info.replay_id);
                if (info.rendered) {
                    var movieId = info.renderId || info.render_id;
                    return deleteMovie(movieId);
                }
            });
        }));
    });
}
exports.deleteReplays = deleteReplays;

/**
 * Get movie for a replay.
 * @param {number} id - The id of the replay to get the movie for.
 * @returns {Promise} - Promise that resolves to the file, or rejects if
 *   there is a filesystem error or the movie isn't rendered.
 */
exports.getMovie = function(id) {
    return db.info.get(id).then(function (info) {
        if (!info.rendered)
            throw new Error("Replay is not rendered.");
        var movieId = info.render_id;
        return fs.getFile("savedMovies/" + movieId).then(function (file) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onloadend = function () {
                    var ab = this.result;
                    resolve({
                        name: info.name,
                        data: ab
                    });
                };
                reader.readAsArrayBuffer(file);
            });
        });
    });
};

/**
 * Save a movie to the file system.
 * @param {number} id - The id of the replay to save the movie for.
 * @param {*} data - The movie data
 * @returns {Promise} - The promise that resolves if the saving
 *   completes successfully, or rejects if there is an error.
 */
exports.saveMovie = function(id, data) {
    // Save movie with same id as info.
    var movieId = id;
    return fs.saveFile("savedMovies/" + movieId, data).then(function () {
        fs.readDirectory("savedMovies").then(function (names) {
            console.log("Movie names: %o.", names);
        }).catch(function (err) {
            console.error("Error reading movies: %o.", err);
        });
        return db.info.update(id, {
            rendered: true,
            render_id: movieId
        });
    });
};

/**
 * Delete movie from the file system.
 * @param {(integer|string)} id - The id of the replay to delete the movie for.
 * @param {Promise} - Promise that resolves when the movie has been
 *   deleted successfully.
 */
function deleteMovie(id) {
    var movieId = id;
    return fs.deleteFile("savedMovies/" + movieId).then(function () {
        return fs.readDirectory("savedMovies").then(function (names) {
            console.log("Movie names: %o.", names);
        }).catch(function (err) {
            console.error("Error reading movies: %o.", err);
        });
    });
}

// ====================================================================
//
// ====================================================================

exports.failedReplaysExist = function() {
    return db.failed_info.count().then(function (n) {
        return n > 0;
    });
};

exports.getFailedReplayInfoList = function(data) {
    var collection = db.failed_info.orderBy(":id");
    return collection.count().then(function (n) {
        return collection.offset(data.start).limit(data.length)
                .toArray().then(function (results) {
            return [n, results];
        });
    });
};

// Returns promise that resolves to object with info id key and failed replay
// info value.
exports.getFailedReplayInfoById = function(ids) {
    return db.failed_info
               .where(":id")
               .anyOf(ids)
             .toArray(function (info) {
        return info.reduce(function (obj, data) {
            obj[data.id] = data;
            return obj;
        }, {});
    });
};

/**
 * Delete replay data, includes the info and raw replay as well as the
 * rendered video, if present.
 * @param {Array.<integer>} ids - The ids of the replays to delete
 * @return {Promise} - Promise that resolves when all ids have been
 *   deleted properly, or rejects on error.
 */
exports.deleteFailedReplays = function(ids) {
    return db.transaction("rw", db.failed_info,
            db.failed_replays, function() {
        return Promise.all(ids.map(function (id) {
            return db.failed_info.get(id).then(function (info) {
                return Promise.all([
                    db.failed_info.delete(id),
                    db.failed_replays.delete(info.replay_id)
                ]);
            });
        }));
    });
};

/**
 * Retrieve the data corresponding to the given replay.
 * @param {integer} id - The info id of the replay to retrieve.
 * @return {Promise} - Promise that resolves to the replay data, or
 *   rejects if the replay is not present or another error occurs.
 */
exports.getFailedReplay = function(id) {
    return db.failed_replays
               .where("info_id")
               .equals(id)
               .first()
             .then(function (replay) {
        if (replay)
            return cleanReplay(replay);

        throw new Error("No replay found.");
    });
};

exports.getFailedReplayInfo = function(id) {
    return db.failed_info.get(id).then(function (info) {
        if (info)
            return info;

        throw new Error("No info found.");
    });
};

/**
 * Iterate over each replay.
 * @param {Arrray.<integer>} ids - Array of ids for the replays to
 *   iterate over.
 * @param {Function} callback - Callback function that receives the replay data and id
 *   for each failed replay.
 * @return {Promise} - Promise that resolves when the iteration is
 *   complete.
 */
exports.forEachFailedReplay = function(ids, callback) {
    return db.failed_replays
               .where("info_id")
               .anyOf(ids)
             .each(function (replay) {
        var info_id = replay.info_id;
        callback(cleanReplay(replay), info_id);
    });
};
