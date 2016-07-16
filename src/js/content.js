var $ = require('jquery');

var Cookies = require('./modules/cookies');
var DOMMessaging = require('./modules/messaging.dom');
var Messaging = require('./modules/messaging');

/**
 * Content script:
 * - adds button to home page
 * - adds record button to game page
 * - injects game listener script
 */

// Callback for options update event, updates the cookies needed
// by the recording script.
function updateCookies(options) {
    Cookies.set('fps', options.fps);
    Cookies.set('duration', options.duration);
    Cookies.set('useRecordKey', options.shortcut_key_enabled);
    Cookies.set('replayRecordKey', options.shortcut_key);
    Cookies.set('record', options.record);
}

// Set listener to update cookies when options are updated.
chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (changes.options && changes.options.newValue) {
        updateCookies(changes.options.newValue);
    }
});

// Options management.
// Get default options object.
function getDefaultOptions() {
    var options = {
        fps: 60,
        duration: 30,
        shortcut_key_enabled: true,
        shortcut_key: 47, // '/' key.
        custom_textures: false,
        canvas_width: 1280,
        canvas_height: 800,
        splats: true,
        ui: true,
        chat: true,
        spin: true,
        record: true // Recording enabled.
    };
    return options;
}

// Ensure extension options are set, setting to default if needed.
function checkOptions() {
    chrome.storage.local.get("options", function(items) {
        if (!items.hasOwnProperty("options") ||
            typeof items.options !== "object") {
            chrome.storage.local.set({
                options: getDefaultOptions()
            });
        }
    });
}

checkOptions();

/**
 * Inserts Replay button in main page
 * @param  {Menu} menu - The menu to open.
 */
function createReplayPageButton() {
    if ($('#userscript-home').length) {
        $('#play-now').after('<a class="btn" id="ReplayMenuButton">Replays');
        $('#ReplayMenuButton').append('<span class="sub-text">watch yourself');
    } else {
        $('div.buttons > a[href="/boards"]').after('<a class="button" id="ReplayMenuButton">Replays');
        $('#ReplayMenuButton').append('<span>watch yourself');
    }

    $('#ReplayMenuButton').click(function () {
        Messaging.send("openMenu");
    });
}

function injectScript(path) {
    var script = document.createElement('script');
    script.setAttribute("type", "application/javascript");
    script.src = chrome.extension.getURL(path);
    script.onload = removeScript;
    (document.head || document.documentElement).appendChild(script);
}

function removeScript() {
    this.parentNode.removeChild(this);
}

// If we're on the main tagpro server screen, create the main menu and
// the button that opens it.
if (document.URL.search(/[a-z]+\/#?$/) >= 0) {
    $(function () {
        // Make the menu-opening button.
        createReplayPageButton();
    });
}

// if we're in a game, as evidenced by there being a port number,
// inject the replayRecording.js script.
if (document.URL.search(/\.\w+:/) >= 0) {
    injectScript("js/record.js");

    // set up listener for info from injected script
    // if we receive data, send it along to the background script for storage
    DOMMessaging.listen('saveReplay', function (data) {
        console.log('Received replay data from injected script, sending to background page.');
        Messaging.send("saveReplay", {
            data: data
        }, function(response) {
            DOMMessaging.send('replaySaved', response.failed);
        });
    });
}