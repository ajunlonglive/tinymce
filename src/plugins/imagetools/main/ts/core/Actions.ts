/**
 * Copyright (c) Tiny Technologies, Inc. All rights reserved.
 * Licensed under the LGPL or a commercial license.
 * For LGPL see License.txt in the project root for license information.
 * For commercial licenses see https://www.tiny.cloud/
 */

import { BlobConversions, ImageTransformations, ResultConversions } from '@ephox/imagetools';
import { Fun } from '@ephox/katamari';
import { URL } from '@ephox/sand';

import Delay from 'tinymce/core/api/util/Delay';
import Promise from 'tinymce/core/api/util/Promise';
import Tools from 'tinymce/core/api/util/Tools';
import URI from 'tinymce/core/api/util/URI';

import * as Settings from '../api/Settings';
import ImageSize from './ImageSize';
import * as Proxy from './Proxy';
import { Editor } from 'tinymce/core/api/Editor';
import { HTMLImageElement, Blob } from '@ephox/dom-globals';

let count = 0;

const isEditableImage = function (editor: Editor, img) {
  const selectorMatched = editor.dom.is(img, 'img:not([data-mce-object],[data-mce-placeholder])');

  return selectorMatched && (isLocalImage(editor, img) || isCorsImage(editor, img) || editor.settings.imagetools_proxy);
};

const displayError = function (editor: Editor, error) {
  editor.notificationManager.open({
    text: error,
    type: 'error'
  });
};

const getSelectedImage = function (editor: Editor) {
  return editor.selection.getNode() as HTMLImageElement;
};

const extractFilename = function (editor: Editor, url) {
  const m = url.match(/\/([^\/\?]+)?\.(?:jpeg|jpg|png|gif)(?:\?|$)/i);
  if (m) {
    return editor.dom.encode(m[1]);
  }
  return null;
};

const createId = function () {
  return 'imagetools' + count++;
};

const isLocalImage = function (editor: Editor, img) {
  const url = img.src;

  return url.indexOf('data:') === 0 || url.indexOf('blob:') === 0 || new URI(url).host === editor.documentBaseURI.host;
};

const isCorsImage = function (editor: Editor, img) {
  return Tools.inArray(Settings.getCorsHosts(editor), new URI(img.src).host) !== -1;
};

const isCorsWithCredentialsImage = function (editor: Editor, img) {
  return Tools.inArray(Settings.getCredentialsHosts(editor), new URI(img.src).host) !== -1;
};

const imageToBlob = function (editor: Editor, img: HTMLImageElement) {
  let src = img.src, apiKey;

  if (isCorsImage(editor, img)) {
    return Proxy.getUrl(img.src, null, isCorsWithCredentialsImage(editor, img));
  }

  if (!isLocalImage(editor, img)) {
    src = Settings.getProxyUrl(editor);
    src += (src.indexOf('?') === -1 ? '?' : '&') + 'url=' + encodeURIComponent(img.src);
    apiKey = Settings.getApiKey(editor);
    return Proxy.getUrl(src, apiKey, false);
  }

  return BlobConversions.imageToBlob(img);
};

const findSelectedBlob = function (editor: Editor) {
  let blobInfo;
  blobInfo = editor.editorUpload.blobCache.getByUri(getSelectedImage(editor).src);
  if (blobInfo) {
    return Promise.resolve(blobInfo.blob());
  }

  return imageToBlob(editor, getSelectedImage(editor));
};

const startTimedUpload = function (editor: Editor, imageUploadTimerState) {
  const imageUploadTimer = Delay.setEditorTimeout(editor, function () {
    editor.editorUpload.uploadImagesAuto();
  }, Settings.getUploadTimeout(editor));

  imageUploadTimerState.set(imageUploadTimer);
};

const cancelTimedUpload = function (imageUploadTimerState) {
  clearTimeout(imageUploadTimerState.get());
};

const updateSelectedImage = function (editor: Editor, ir, uploadImmediately, imageUploadTimerState, size?) {
  return ir.toBlob().then(function (blob) {
    let uri, name, blobCache, blobInfo, selectedImage;

    blobCache = editor.editorUpload.blobCache;
    selectedImage = getSelectedImage(editor);
    uri = selectedImage.src;

    if (Settings.shouldReuseFilename(editor)) {
      blobInfo = blobCache.getByUri(uri);
      if (blobInfo) {
        uri = blobInfo.uri();
        name = blobInfo.name();
      } else {
        name = extractFilename(editor, uri);
      }
    }

    blobInfo = blobCache.create({
      id: createId(),
      blob,
      base64: ir.toBase64(),
      uri,
      name
    });

    blobCache.add(blobInfo);

    editor.undoManager.transact(function () {
      function imageLoadedHandler() {
        editor.$(selectedImage).off('load', imageLoadedHandler);
        editor.nodeChanged();

        if (uploadImmediately) {
          editor.editorUpload.uploadImagesAuto();
        } else {
          cancelTimedUpload(imageUploadTimerState);
          startTimedUpload(editor, imageUploadTimerState);
        }
      }

      editor.$(selectedImage).on('load', imageLoadedHandler);
      if (size) {
        editor.$(selectedImage).attr({
          width: size.w,
          height: size.h
        });
      }

      editor.$(selectedImage).attr({
        src: blobInfo.blobUri()
      }).removeAttr('data-mce-src');
    });

    return blobInfo;
  });
};

const selectedImageOperation = function (editor: Editor, imageUploadTimerState, fn, size?) {
  return function () {
    return editor._scanForImages().
      then(Fun.curry(findSelectedBlob, editor)).
      then(ResultConversions.blobToImageResult).
      then(fn).
      then(function (imageResult) {
        return updateSelectedImage(editor, imageResult, false, imageUploadTimerState, size);
      }, function (error) {
        displayError(editor, error);
      });
  };
};

const rotate = function (editor: Editor, imageUploadTimerState, angle) {
  return function () {
    const size = ImageSize.getImageSize(getSelectedImage(editor));
    const flippedSize = size ? {w: size.h, h: size.w} : null;

    return selectedImageOperation(editor, imageUploadTimerState, function (imageResult) {
      return ImageTransformations.rotate(imageResult, angle);
    }, flippedSize)();
  };
};

const flip = function (editor: Editor, imageUploadTimerState, axis) {
  return function () {
    return selectedImageOperation(editor, imageUploadTimerState, function (imageResult) {
      return ImageTransformations.flip(imageResult, axis);
    })();
  };
};

const handleDialogBlob = function (editor: Editor, imageUploadTimerState, img, originalSize, blob: Blob) {
  return new Promise(function (resolve) {
    BlobConversions.blobToImage(blob).
      then(function (newImage) {
        const newSize = ImageSize.getNaturalImageSize(newImage);

        if (originalSize.w !== newSize.w || originalSize.h !== newSize.h) {
          if (ImageSize.getImageSize(img)) {
            ImageSize.setImageSize(img, newSize);
          }
        }

        URL.revokeObjectURL(newImage.src);
        return blob;
      }).
      then(ResultConversions.blobToImageResult).
      then(function (imageResult) {
        return updateSelectedImage(editor, imageResult, true, imageUploadTimerState);
      }, function () {
        // Close dialog
      });
  });
};

export default {
  rotate,
  flip,
  isEditableImage,
  cancelTimedUpload,
  findSelectedBlob,
  getSelectedImage,
  handleDialogBlob
};