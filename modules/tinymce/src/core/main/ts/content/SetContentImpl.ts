/**
 * Copyright (c) Tiny Technologies, Inc. All rights reserved.
 * Licensed under the LGPL or a commercial license.
 * For LGPL see License.txt in the project root for license information.
 * For commercial licenses see https://www.tiny.cloud/
 */

import { Optional, Type } from '@ephox/katamari';
import { Remove, SugarElement } from '@ephox/sugar';

import Editor from '../api/Editor';
import AstNode from '../api/html/Node';
import HtmlSerializer from '../api/html/Serializer';
import * as Settings from '../api/Settings';
import Tools from '../api/util/Tools';
import * as CaretFinder from '../caret/CaretFinder';
import { isWsPreserveElement } from '../dom/ElementType';
import * as NodeType from '../dom/NodeType';
import * as EditorFocus from '../focus/EditorFocus';
import * as FilterNode from '../html/FilterNode';
import { Content, SetContentArgs } from './ContentTypes';
import { postProcessSetContent, preProcessSetContent } from './PrePostProcess';

interface SetContentResult {
  readonly content: Content;
  readonly html: string;
}

const defaultFormat = 'html';

const isTreeNode = (content: unknown): content is AstNode =>
  content instanceof AstNode;

const moveSelection = (editor: Editor): void => {
  if (EditorFocus.hasFocus(editor)) {
    CaretFinder.firstPositionIn(editor.getBody()).each((pos) => {
      const node = pos.getNode();
      const caretPos = NodeType.isTable(node) ? CaretFinder.firstPositionIn(node).getOr(pos) : pos;
      editor.selection.setRng(caretPos.toRange());
    });
  }
};

const setEditorHtml = (editor: Editor, html: string | Node, noSelection: boolean | undefined): void => {
  if (Type.isString(html)) {
    editor.dom.setHTML(editor.getBody(), html);
  } else {
    Remove.empty(SugarElement.fromDom(editor.getBody()));
    editor.getBody().appendChild(html);
  }
  if (noSelection !== true) {
    moveSelection(editor);
  }
};

const setContentString = (editor: Editor, body: HTMLElement, content: string, args: SetContentArgs): SetContentResult => {
  // Padd empty content in Gecko and Safari. Commands will otherwise fail on the content
  // It will also be impossible to place the caret in the editor unless there is a BR element present
  if (content.length === 0 || /^\s+$/.test(content)) {
    const padd = '<br data-mce-bogus="1">';

    // Todo: There is a lot more root elements that need special padding
    // so separate this and add all of them at some point.
    if (body.nodeName === 'TABLE') {
      content = '<tr><td>' + padd + '</td></tr>';
    } else if (/^(UL|OL)$/.test(body.nodeName)) {
      content = '<li>' + padd + '</li>';
    }

    const forcedRootBlockName = Settings.getForcedRootBlock(editor);

    // Check if forcedRootBlock is configured and that the block is a valid child of the body
    if (forcedRootBlockName && editor.schema.isValidChild(body.nodeName.toLowerCase(), forcedRootBlockName.toLowerCase())) {
      content = padd;
      content = editor.dom.createHTML(forcedRootBlockName, Settings.getForcedRootBlockAttrs(editor), content);
    } else if (!content) {
      // We need to add a BR when forced_root_block is disabled on non IE browsers to place the caret
      content = '<br data-mce-bogus="1">';
    }

    setEditorHtml(editor, content, args.no_selection);

    return { content, html: content };
  } else {
    // TODO: bring back `raw` handling
    const fragment = editor.parser.parse(content, { isRootContent: true, insert: true });

    setEditorHtml(editor, fragment, args.no_selection);

    return { content, html: content };
  }
};

const setContentTree = (editor: Editor, body: HTMLElement, content: AstNode, args: SetContentArgs): SetContentResult => {
  FilterNode.filter(editor.parser.getNodeFilters(), editor.parser.getAttributeFilters(), content);

  const html = HtmlSerializer({ validate: false }, editor.schema).serialize(content);

  const trimmedHtml = isWsPreserveElement(SugarElement.fromDom(body)) ? html : Tools.trim(html);
  setEditorHtml(editor, trimmedHtml, args.no_selection);

  return { content, html: trimmedHtml };
};

const setupArgs = (args: Partial<SetContentArgs>, content: Content): SetContentArgs => ({
  format: defaultFormat,
  ...args,
  set: true,
  content: isTreeNode(content) ? '' : content
});

export const setContentInternal = (editor: Editor, content: Content, args: Partial<SetContentArgs>): Content => {
  const defaultedArgs = setupArgs(args, content);
  return preProcessSetContent(editor, defaultedArgs).map((updatedArgs) => {
    // Don't use the content from the args for tree, as it'll be an empty string
    const updatedContent = isTreeNode(content) ? content : updatedArgs.content;

    const result = Optional.from(editor.getBody()).map((body) => {
      if (isTreeNode(updatedContent)) {
        return setContentTree(editor, body, updatedContent, updatedArgs);
      } else {
        return setContentString(editor, body, updatedContent, updatedArgs);
      }
    }).getOr({ content, html: updatedArgs.content });

    postProcessSetContent(editor, result.html, updatedArgs);
    return result.content;
  }).getOr(content);
};
