var $ = require('jquery');

var Storage = require('./storage');
var Util = require('./util');
var reader = require('./file-reader');
var image = require('./image');
var logger = require('./logger')('textures');

// Save image from texture dialog.
exports.saveSettings = function () {
  // Mapping from file input ids to texture object properties.
  var imageSources = {
    tilesInput: "tiles",
    portalInput: "portal",
    speedpadInput: "speedpad",
    speedpadredInput: "speedpadred",
    speedpadblueInput: "speedpadblue",
    splatsInput: "splats"
  };

  var result = {};
  return Promise.all(Util.map(imageSources, (elt_id, key) => {
    var file = $(`#${elt_id}`)[0].files[0];
    if (!file) return;
    return reader.readAsDataURL(file).then((data) => {
      result[key] = data;
    });
  })).then(() => {
    return Storage.get("textures").then((items) => {
      var textures = items.textures;
      if (textures) {
        Object.assign(textures, result);
        return Storage.set({
          textures: textures
        });
      } else {
        throw new Error("Textures not set.");
      }
    });
  });
};

/**
 * Texture as saved in `chrome.storage`.
 * @typedef TextureData
 * @type {object}
 * @property {string} tiles - Data URL for tiles image.
 * @property {string} portal - Data URL for portal image.
 * @property {string} speedpad - Data URL for speedpad image.
 * @property {string} speedpadred - Data URL for speedpadred image.
 * @property {string} speedpadblue - Data URL for speedpadblue image.
 * @property {string} splats - Data URL for splats image.
 * @property {string} flair - Data URL for flair image.
 * @property {string} tagpro - Data URL for tagpro image.
 * @property {string} rollingbomb - Data URL for rollingbomb image.
 */
/**
 * Object which contains textures saved as images appropriate for use
 * as image sources for canvas rendering.
 * @typedef TextureImages
 * @type {object}
 * @property {Image} tiles - Image for the tiles texture.
 * @property {Image} portal - Image for the portal texture.
 * @property {Image} speedpad - Image for the speedpad texture.
 * @property {Image} speedpadred - Image for the speedpadred texture.
 * @property {Image} speedpadblue - Image for the speedpadblue texture.
 * @property {Image} splats - Image for the splats texture.
 * @property {Image} flair - Image for the flair texture.
 * @property {Image} tagpro - Image for the tagpro texture.
 * @property {Image} rollingbomb - Image for the rollingbomb texture.
 */
/**
 * Callback function that receives the retrieved texture images.
 * @callback TextureCallback
 * @param {TextureImages} textures - The constructed images
 *   representing the textures.
 */
/**
 * Get image elements for the given set of textures. If custom textures
 * are turned off, then this will construct images using the default
 * texture pack.
 * @param  {TextureData}   textures - The textures as retrieved from
 *   `chrome.storage`.
 * @param  {TextureCallback} callback - The function called with the
 *   result of constructing the texture images.
 */
exports.getImages = function (textures) {
  var images = {};
  return Promise.all(Util.map(textures, (id, dataUrl) => {
    return image.load(dataUrl).then((img) => {
      images[id] = img;
    });
  })).then(() => images);
};

/**
 * Get a data URL for the image.
 * @param {Image} img - The image.
 * @returns {string} the Data URL representing the image.
 */
function imageToDataURL(img) {
  var canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  var ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  var dataUrl = canvas.toDataURL("image/png");
  return dataUrl;
}

// Get initial texture information from extension.
// callback is passed the new textures object.
// Should only be called from background page to prevent cross-origin
// canvas contamination.
function getDefaultTextures() {
  var defaultTextures = {
    tiles: 'images/textures/tiles.png',
    portal: 'images/textures/portal.png',
    speedpad: 'images/textures/speedpad.png',
    speedpadred: 'images/textures/speedpadred.png',
    speedpadblue: 'images/textures/speedpadblue.png',
    splats: 'images/textures/splats.png',
    flair: 'images/textures/flair.png',
    rollingbomb: 'images/textures/rollingbomb.png',
    tagpro: 'images/textures/tagpro.png'
  };

  var result = {};
  return Promise.all(Util.map(defaultTextures, (id, url) => {
    return image.load(url).then((img) => {
      result[id] = imageToDataURL(img);
    })
  })).then(() => result);
}

exports.getDefault = getDefaultTextures;

function setDefaultTextures() {
  return getDefaultTextures().then((textures) => {
    // Use clone for same object, otherwise default_textures is
    // null.
    return Storage.set({
      textures: textures,
      default_textures: Util.clone(textures)
    });
  });
}

/**
 * Ensure textures are set and ready.
 * @type {Promise}
 */
exports.ready = function () {
  return Storage.get(["default_textures", "textures"]).then((items) => {
    if (!items.textures || !items.default_textures) {
      return setDefaultTextures();
    }
  });
}
