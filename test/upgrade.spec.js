var Data = require('modules/data');
var Subsystems = require('modules/subsystem');
var convert = require('modules/convert');

var jsonfile = require('jsonfile');
var $ = require('jquery');
var async = require('async');
var Dexie = require('dexie');

Dexie.debug = false;
var files = {
  1: [
    "HOW_TO_WIN_AT_EVENT_HORIZONDATE1429567229815.txt",
    "replays1431810391430.txt",
    "replays1430861081332.txt",
    "replays1431836535487.txt",
    "replays1430867339575.txt",
    "replays1431912125451.txt",
    "replays1430948549004.txt",
    "replays1431917583791.txt",
    "replays1431289119971.txt",
    "replays1431917760968.txt",
    "replays1431381196146.txt",
    "replays1432182077449.txt",
    "replays1431382178597.txt",
    "replays1432332868378.txt",
    "replays1431382380136.txt",
    "replays1432333294171.txt",
    "replays1431382541556.txt",
    "replays1432333387755.txt",
    "replays1431468001167.txt",
    "replays1432352416317.txt",
    "replays1431468692137.txt",
    "replays1432354635168.txt",
    "replays1431469491151.txt",
    "replays1432520044708.txt",
    "replays1431480891558.txt",
    "replays1432521073920.txt",
    "replays1431485670653.txt",
    "replays1432590816052.txt",
    "replays1431486564926.txt",
    "replays1432593718834.txt",
    "replays1431743346120.txt"
  ]
};

function get_replays(version) {
  console.log("Getting version " + version + " replays.");
  return new Promise(function (resolve, reject) {
    async.map(files[version], function (path, callback) {
      $.ajax({
        url: "/fixtures/replays_" + version + "/" + path,
        dataType: "text" 
      }).done(function (data) {
        callback(null, {
          name: path,
          data: data
        });
      }).fail(function (err) {
        callback("Error getting " + path);
      });
    }, function (err, result) {
      if (err) {
        console.log("Error getting version " + version + " replays.");
        reject(err);
      } else {
        console.log("Retrieved " + result.length +
            " version " + version + " replays.");
        resolve(result);
      }
    });
  });
}

// Setup function for db v_1
function setup_1(spec) {
  console.log("Setting up for version 1.");
  return Data.init(spec.db_version, false).then(function () {
    return get_replays(spec.replay_version);
  }).then(function (data) {
    console.log("Adding replays.");
    var db = Data.db;
    return db.transaction("rw", db.positions, function () {
      console.log("Starting transaction.");
      return new Dexie.Promise(function (resolve, reject) {
        async.eachSeries(data, function (data, callback) {
          var name = data.name;
          var content = data.data;
          console.log("Adding replay " + name + ".");
          db.positions.add(content, name).then(function () {
            console.log("Successfully added replay " + name + ".");
            callback();
          }).catch(function (err) {
            console.error("Error adding " + name + ", sending error back up.");
            callback(err);
          });
        }, function (err) {
          if (err) {
            console.log("Error adding replays.");
            reject(err);
          } else {
            console.log("Finished adding replays.");
            //db.close();
            resolve();
          }
        });
      });
    });
  });
}

describe('db', function () {
  // Disable timeout.
  this.timeout(0);
  before('setup subsystems', function () {
    Subsystems.add("convert", convert.ready);
    return Subsystems.init();
  });
  
  beforeEach(function (done) {
    Data.db.delete().then(function () {
      done();
    });
    // Remove all Data listeners.
  });

  afterEach(function () {
    // Delete database.
    Data.db.delete();
    // Remove all Data listeners.
  });
  
  it('should handle upgrades', function (done) {
    setup_1({
      db_version: 0.1,
      replay_version: 1,
      replays: 10,
      errors: false
    }).then(function () {
      Data.db.close();
      console.log("Initializing Data");
      Data.init();
    });
    Data.events.on("db:upgrade", function () {
      console.log("db:upgrade");
    });
    Data.events.on("db:open", function () {
      console.log("db:open");
      // check that upgrade occurred
      // check that upgrades occurred correctly.
      done();
    });
    Data.events.on("db:err", function (reason) {
      done(Error("DB Error: " + reason));
    });
  });
});

Data.events.on("db:open", function () {
  console.log("DB opened.");
});

Data.events.on("db:err", function (err) {
  console.log("Error opening db");
});

Data.events.on("db:err:upgrade", function (err) {
  console.log("Error upgrading db");
});

Data.events.on("db:upgrade", function () {
  console.log("Upgrading db");
});

Data.events.on("db:upgrade:progress", function () {
  console.log("Got progress.");
});

/*function got() {
  console.log("got it");
}

var urls = [
  "/schemas/1/definitions.json",
  "/schemas/1/data.json",
  "/schemas/1/player.json",
  "/schemas/2/replay.json",
  "/schemas/2/player.json",
  "/schemas/2/db_info.json",
  "/schemas/2/data.json"
];;

urls.forEach((url) => {
  var r = new XMLHttpRequest();
  r.addEventListener("load", got);
  r.open("GET", url);
  r.send();
});
*/