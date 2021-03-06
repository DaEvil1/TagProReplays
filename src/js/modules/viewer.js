var $ = require('jquery');
require('jquery-ui');
require('bootstrap');

var Messaging = require('./messaging');
var Renderer = require('./renderer');
var Textures = require('./textures');

/**
 * Code to support the in-page replay viewer. This file is included as
 * a content script.
 */
module.exports = Viewer;

// Handle the interaction with the viewer for a replay.
function Viewer() {
    $('article').append(
        '<div id="tpr-viewer-container" class="bootstrap-container jquery-ui-container">');
    var url = chrome.extension.getURL("html/viewer.html");
    $("#tpr-viewer-container").load(url, function() {
        this.init();
    }.bind(this));
}

/**
 * Initialize the viewer.
 * @private
 */
Viewer.prototype.init = function() {
    this.canvas = $("#viewer-canvas")[0];
    this.frame = 0;
    this.frames = 0;
    this.playing = false;
    this.playInterval = null;
    this.cropping = false;
    this.timeActive = false;

    var self = this;

    // Opt-in to bootstrap tooltips.
    $("#tpr-viewer-container [data-toggle='tooltip']").tooltip();

    // Set listeners.
    $("#time-slider").slider({
        min: 0,
        max: this.frames,
        value: 0,
        range: "min",
        slide: function(event, ui) {
            var value = ui.value;
            if (!self.playing) {
                self.frame = value;
                self.drawFrame();
                self.updateUI();
            } else {
                clearInterval(self.playInterval);
                if (value >= self.lastFrame) {
                    self.play(value, self.frames);
                } else {
                    self.play(value, self.lastFrame);
                }
            }
        },
        change: function(event) {
            // Ensure this was a user-initiated event.
            if (event.originalEvent) {
                self.frame = $("#time-slider").slider("value");
                self.drawFrame();
                self.updateUI();
            }
        }
    });

    $(".time-slider-container").mouseenter(function() {
        if (!self.timeActive) {
            self.timeActive = true;
            self.showSeek();
        }
    });

    $(".time-slider-container").mouseleave(function() {
        if (self.timeActive && self.playing) {
            self.timeActive = false;
            setTimeout(function() {
                // Don't hide if active again.
                if (self.timeActive || !self.playing) return;
                self.hideSeek();
            }, 500);
        }
    });

    // Setup crop slider.
    $("#crop-slider").slider({
        range: true,
        min: 0,
        max: this.frames,
        values: [0, this.frames]
    });

    $("#viewer-controls").on("click", ".tpr-button-stop", function() {
        self.close();
    });

    $("#viewer-controls").on("click", ".tpr-button-reset", function() {
        self.reset();
        self.drawFrame();
    });

    $("#viewer-controls").on("click", ".tpr-button-play", function() {
        self.play(self.frame, self.frames);
    });

    $("#viewer-controls").on("click", ".tpr-button-pause", function() {
        self.pause();
    });

    $("#viewer-controls").on("click", ".tpr-button-crop-start", function() {
        var cropRange = $("#crop-slider").slider("values");
        var newStart = $("#time-slider").slider("value");
        var newRange = [newStart];
        if (newStart >= cropRange[1]) {
            newRange.push(self.frames);
        } else {
            newRange.push(cropRange[1]);
        }
        $("#crop-slider").slider('values', newRange);
        if (!self.cropping) {
            self.cropping = true;
            self.showCrop();
        }
    });

    $("#viewer-controls").on("click", ".tpr-button-crop-end", function() {
        var cropRange = $("#crop-slider").slider("values");
        var newEnd = $("#time-slider").slider("value");
        var newRange = [newEnd];
        if (newEnd <= cropRange[0]) {
            newRange.unshift(0);
        } else {
            newRange.unshift(cropRange[0]);
        }
        $("#crop-slider").slider('values', newRange);
        if (!self.cropping) {
            self.cropping = true;
            self.showCrop();
        }
    });

    $("#viewer-controls").on("click", ".tpr-button-crop-play", function() {
        var range = $("#crop-slider").slider("values");
        self.play(range[0], range[1]);
    });

    // Crop replay data and save as a new replay.
    $("#viewer-controls").on("click", ".tpr-button-crop", function() {
        self.pause();
        var newName = prompt('If you would also like to name the new' +
            ' cropped replay, type the new name here. Leave it blank ' +
            'to make a generic name.');
        // Cancelled operation.
        if (newName === null) return;
        var range = $("#crop-slider").slider("values");
        var msg = {
            id: self.id,
            start: range[0],
            end: range[1]
        };
        if (newName !== '') {
            msg.name = newName;
        }
        // TODO: Handle error with replay cropping, or refresh
        // previewer with cropped replay.
        Messaging.send("cropReplay", msg, function (response) {
            if (!response.failed) {
                self._viewReplay(response.id, response.data);
            }
        });
    });

    $("#viewer-controls").on("click", ".tpr-button-crop-replace", function() {
        self.pause();
        var newName = prompt('If you would also like to rename this ' +
            'replay, type the new name here. Leave it blank to use ' +
            'the old name.');
        // Cancelled operation.
        if (newName === null) return;
        var range = $("#crop-slider").slider("values");
        var msg = {
            id: self.id,
            start: range[0],
            end: range[1]
        };
        if (newName !== '') {
            msg.name = newName;
        }
        // Update previewer with cropped replay.
        Messaging.send("cropAndReplaceReplay", msg, function (response) {
            if (!response.failed) {
                self._viewReplay(response.id, response.data);
            }
        });
    });

    $("#viewer-controls").on("click", ".tpr-button-delete", function() {
        if (confirm('Are you sure you want to delete this replay?')) {
            self.close();
            console.log('Requesting deletion of replay ' + self.id + '.');
            Messaging.send("deleteReplay", {
                id: self.id
            });
        }
    });

    $("#viewer-controls").on("click", ".tpr-button-render", function() {
        if (confirm('Are you sure you want to render this replay?')) {
            self.close();
            console.log('Requesting render of replay ' + self.id + '.');
            Messaging.send("renderReplay", {
                id: self.id
            });
        }
    });

    $("#viewer-controls").on("click", ".tpr-button-rename", function() {
        var newName = prompt('How would you like to rename ' + self.replay.info.name + '?');
        if (newName !== null && newName !== "") {
            console.log('Requesting rename from ' + self.replay.info.name + ' to ' + newName + '.');
            Messaging.send("renameReplay", {
                id: self.id,
                name: newName
            });
        }
    });
};

// Initialize viewer to work with replay that has provided id.
Viewer.prototype.preview = function(id) {
    // Show viewer.
    this.show();
    var self = this;
    // Get replay data.
    console.log('Requesting data for replay ' + id + ".");
    Messaging.send("getReplay", {
        id: id
    }, function(response) {
        console.log('Data received for replay ' + id + ".");
        self._viewReplay(id, response.data);
    });
};

/**
 * Internal method for initializing the viewer for a replay.
 * @private
 * @param {integer} id - The id of the replay.
 * @param {Replay} replay - The replay data.
 */
Viewer.prototype._viewReplay = function(id, replay) {
    this.id = id;
    this.replay = replay;
    this.replayInit();
};

// Display the viewer.
Viewer.prototype.show = function() {
    $("#tpr-viewer-container").fadeIn(300);
};

// Hide the viewer.
Viewer.prototype.hide = function() {
    $("#tpr-viewer-container").fadeOut(500);
    $("#menuContainer").fadeIn(500);
};

// Initialize the viewer after retrieving the replay data.
Viewer.prototype.replayInit = function() {
    var self = this;
    this.canvas.title = "Replay: " + this.replay.info.name;
    this.frames = this.replay.data.time.length - 1;

    $("#time-slider").slider("option", "max", this.frames);
    $("#crop-slider").slider("option", "max", this.frames);
    $("#crop-slider").slider("values", [0, this.frames]);
    // Reset crop indicators.
    if (this.cropping) {
        this.cropping = false;
        this.hideCrop();
    }

    // Pause if playing.
    this.pause();

    // Reset to beginning.
    this.reset();

    // Get options and textures.
    chrome.storage.local.get(["options", "textures", "default_textures"], function(items) {
        var opts = items.options;
        var textures = opts.custom_textures ? items.textures
                                            : items.default_textures;
        Textures.getImages(textures, function (textureImages) {
            self.renderer = new Renderer(self.replay, {
                options: opts,
                textures: textureImages,
                canvas: self.canvas
            });
            self.drawFrame();
        });
    });
};

/**
 * Hide cropping indicators.
 */
Viewer.prototype.showCrop = function() {
    $("#crop-slider .ui-slider-handle").show();
};

/**
 * Show cropping indicators.
 */
Viewer.prototype.hideCrop = function() {
    $("#crop-slider .ui-slider-handle").hide();
};

/**
 * Show the seek bar and handle.
 */
Viewer.prototype.showSeek = function() {
    var transform = {
        transform: 'scaleY(1)',
        transition: 'transform .1s ease-out'
    };
    $("#time-slider").css(transform);
    $("#crop-slider .ui-slider-handle").css(transform);
    $("#time-slider .ui-slider-handle").css({
        display: 'block',
        opacity: 1
    });
};

/**
 * Hide the seek bar and handle.
 * @param {boolean} [instant=false] - Whether the bar should hide
 *   instantly.
 */
Viewer.prototype.hideSeek = function(instant) {
    function remove() {
        $("#time-slider .ui-slider-handle").css({ display: 'none' });
        $("#time-slider .ui-slider-handle")[0].removeEventListener("transitionend", remove);
    }
    var transform = {
        transform: 'scaleY(0.375)',
        transition: 'transform .5s ease-in'
    };
    $("#time-slider").css(transform);
    $("#crop-slider .ui-slider-handle").css(transform);
    $("#time-slider .ui-slider-handle").css({
        opacity: 0
    });
    $("#time-slider .ui-slider-handle")[0].addEventListener("transitionend", remove);
};

/**
 * Set frame to value.
 */
Viewer.prototype.setFrame = function(frame) {
    this.frame = frame;
    $("#time-slider").slider("value", frame);
};

// Draws the current frame.
Viewer.prototype.drawFrame = function() {
    this.renderer.drawFrame(this.frame);
};

/**
 * Close the previewer, resetting necessary state.
 */
Viewer.prototype.close = function() {
    this.reset();
    this.hide();
};

/**
 * Stop the replay.
 * @private
 */
Viewer.prototype.pause = function() {
    if (this.playing) {
        clearInterval(this.playInterval);
        this.playInterval = null;
        this.lastFrame = null;
        this.playing = false;
        this.updateUI();
        this.showSeek();
    }
};

/**
 * Update user interface
 * @private
 */
Viewer.prototype.updateUI = function() {
    if (this.playing) {
        $(".tpr-button-play").addClass("hidden");
        $(".tpr-button-pause").removeClass("hidden");
    } else {
        $(".tpr-button-pause").addClass("hidden");
        if (this.frame >= this.frames) {
            $(".tpr-button-reset").removeClass("hidden");
            $(".tpr-button-play").addClass("hidden");
        } else {
            $(".tpr-button-reset").addClass("hidden");
            $(".tpr-button-play").removeClass("hidden");
        }
    }
};

/**
 * Reset the replay to the beginning.
 */
Viewer.prototype.reset = function() {
    this.pause();
    this.setFrame(0);
    this.updateUI();
};

// Play preview starting at the given frame and ending at the other
// argument.
Viewer.prototype.play = function(start, end) {
    // Reset anything currently playing.
    this.reset();
    this.playing = true;
    this.hideSeek();
    this.updateUI();

    var time = Date.now();
    var startTime = time;
    var fps = this.replay.info.fps;
    this.setFrame(start);
    this.lastFrame = end;
    this.playInterval = setInterval(function() {
        if (this.frame >= this.lastFrame) {
            this.pause();
            return;
        }
        this.drawFrame();
        var dt = Date.now() - time;
        time = Date.now();
        var nFramesToAdvance = Math.round(dt / (1000 / fps));
        var newFrame = Math.min(this.frame + nFramesToAdvance, this.frames);
        this.setFrame(newFrame);
    }.bind(this), 1000 / fps);
};
