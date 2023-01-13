import Delta from 'quill-delta';
import DeltaOp from 'quill-delta/lib/op';
import Parchment, { Scope } from 'parchment';
import CodeBlock from '../formats/code';
import CursorBlot from '../blots/cursor';
import Block, { BlockEmbed, bubbleFormats } from '../blots/block';
import Break from '../blots/break';
import clone from 'clone';
import equal from 'deep-equal';
import extend from 'extend';


class Editor {
  constructor(scroll) {
    this.scroll = scroll;
    this.delta = this.getDelta();
  }

  applyDelta(delta) {
    const originalDelta = clone(delta);
    this.scroll.update();
    let scrollLength = this.scroll.length();
    this.scroll.batchStart();
    const normalizedDelta = normalizeDelta(delta);
    const deleteDelta = new Delta();
    normalizedDelta.reduce((index, op) => {
      let length = op.retain || op.delete || op.insert.length || 1;
      let attributes = op.attributes || {};
      let addedNewline = false;
      if (op.insert != null) {
        deleteDelta.retain(length);
        if (typeof op.insert === 'string') {
          let text = op.insert;
          addedNewline =
            !text.endsWith('\n') &&
            (scrollLength <= index ||
              this.scroll.descendant(BlockEmbed, index)[0]);
          this.scroll.insertAt(index, text);
          let [line, offset] = this.scroll.line(index);
          let formats = extend({}, bubbleFormats(line));
          if (line instanceof Block) {
            let [leaf, ] = line.descendant(Parchment.Leaf, offset);
            formats = extend(formats, bubbleFormats(leaf));
          }
          attributes = DeltaOp.attributes.diff(formats, attributes) || {};
        } else if (typeof op.insert === 'object') {
          let key = Object.keys(op.insert)[0];  // There should only be one key
          if (key == null) return index;
          addedNewline =
            this.scroll.query(key, Scope.INLINE) != null &&
            (scrollLength <= index ||
              this.scroll.descendant(BlockEmbed, index)[0]);
          this.scroll.insertAt(index, key, op.insert[key]);
        }
        scrollLength += length;
      } else {
        deleteDelta.push(op);
      }
      Object.keys(attributes).forEach((name) => {
        this.scroll.formatAt(index, length, name, attributes[name]);
      });
      const addedLength = addedNewline ? 1 : 0;
      scrollLength += addedLength;
      deleteDelta.delete(addedLength);
      return index + length + addedLength;
    }, 0);
    deleteDelta.reduce((index, op) => {
      if (typeof op.delete === 'number') {
        this.scroll.deleteAt(index, op.delete);
        return index;
      }
      const length = op.retain || op.insert.length || 1;
      return index + length;
    }, 0);
    this.scroll.batchEnd();
    return this.update(normalizedDelta, undefined, undefined, originalDelta);
  }

  deleteText(index, length) {
    this.scroll.deleteAt(index, length);
    const delta = new Delta().retain(index).delete(length);
    return this.update(delta, undefined, undefined, delta);
  }

  formatLine(index, length, formats = {}) {
    this.scroll.update();
    Object.keys(formats).forEach((format) => {
      if (this.scroll.whitelist != null && !this.scroll.whitelist[format]) return;
      let lines = this.scroll.lines(index, Math.max(length, 1));
      let lengthRemaining = length;
      lines.forEach((line) => {
        let lineLength = line.length();
        if (!(line instanceof CodeBlock)) {
          line.format(format, formats[format]);
        } else {
          let codeIndex = index - line.offset(this.scroll);
          let codeLength = line.newlineIndex(codeIndex + lengthRemaining) - codeIndex + 1;
          line.formatAt(codeIndex, codeLength, format, formats[format]);
        }
        lengthRemaining -= lineLength;
      });
    });
    this.scroll.optimize();
    return this.update(new Delta().retain(index).retain(length, clone(formats)));
  }

  formatText(index, length, formats = {}) {
    Object.keys(formats).forEach((format) => {
      this.scroll.formatAt(index, length, format, formats[format]);
    });
    const delta = new Delta().retain(index).retain(length, clone(formats));
    return this.update(delta, undefined, undefined, delta);
  }

  getContents(index, length) {
    return this.delta.slice(index, index + length);
  }

  getDelta() {
    return this.scroll.lines().reduce((delta, line) => {
      return delta.concat(line.delta());
    }, new Delta());
  }

  getFormat(index, length = 0) {
    let lines = [], leaves = [];
    if (length === 0) {
      this.scroll.path(index).forEach(function(path) {
        let [blot, ] = path;
        if (blot instanceof Block) {
          lines.push(blot);
        } else if (blot instanceof Parchment.Leaf) {
          leaves.push(blot);
        }
      });
    } else {
      lines = this.scroll.lines(index, length);
      leaves = this.scroll.descendants(Parchment.Leaf, index, length);
    }
    let formatsArr = [lines, leaves].map(function(blots) {
      if (blots.length === 0) return {};
      let formats = bubbleFormats(blots.shift());
      while (Object.keys(formats).length > 0) {
        let blot = blots.shift();
        if (blot == null) return formats;
        formats = combineFormats(bubbleFormats(blot), formats);
      }
      return formats;
    });
    return extend.apply(extend, formatsArr);
  }

  getText(index, length) {
    return this.getContents(index, length).filter(function(op) {
      return typeof op.insert === 'string';
    }).map(function(op) {
      return op.insert;
    }).join('');
  }

  insertEmbed(index, embed, value) {
    this.scroll.insertAt(index, embed, value);
    return this.update(new Delta().retain(index).insert({ [embed]: value }));
  }

  insertText(index, text, formats = {}) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.scroll.insertAt(index, text);
    Object.keys(formats).forEach((format) => {
      this.scroll.formatAt(index, text.length, format, formats[format]);
    });
    const delta = new Delta().retain(index).insert(text, clone(formats));
    return this.update(delta, undefined, undefined, delta);
  }

  isBlank() {
    if (this.scroll.children.length == 0) return true;
    if (this.scroll.children.length > 1) return false;
    let block = this.scroll.children.head;
    if (block.statics.blotName !== Block.blotName) return false;
    if (block.children.length > 1) return false;
    return block.children.head instanceof Break;
  }

  removeFormat(index, length) {
    let text = this.getText(index, length);
    let [line, offset] = this.scroll.line(index + length);
    let suffixLength = 0, suffix = new Delta();
    if (line != null) {
      if (!(line instanceof CodeBlock)) {
        suffixLength = line.length() - offset;
      } else {
        suffixLength = line.newlineIndex(offset) - offset + 1;
      }
      suffix = line.delta().slice(offset, offset + suffixLength - 1).insert('\n');
    }
    let contents = this.getContents(index, length + suffixLength);
    let diff = contents.diff(new Delta().insert(text).concat(suffix));
    let delta = new Delta().retain(index).concat(diff);
    return this.applyDelta(delta);
  }

  cleanDocumentDelta() {
    while (this.delta.ops.length > 0) {
      if (!this.delta.ops[this.delta.ops.length - 1].insert) {
        // remove trailing retains and deletes
        this.delta.ops.pop();
      } else {
        break;
      }
    }
  }

  update(change, mutations = [], cursorIndex = undefined, deltaSinceLastUpdate = undefined) {
    let oldDelta = this.delta;
    if (deltaSinceLastUpdate === undefined) {
        deltaSinceLastUpdate = change;
    }
    mutations = mutations.filter(
        (mutation) => !(
            mutation.type === 'attributes' && mutation.attributeName &&
            mutation.attributeName.startsWith('data-')
        )
    );
    if (mutations.length === 1 &&
        mutations[0].type === 'characterData' &&
        Parchment.find(mutations[0].target)) {
      // Optimization for character changes
      let textBlot = Parchment.find(mutations[0].target);
      let formats = bubbleFormats(textBlot);
      let index = textBlot.offset(this.scroll);
      let oldValue = mutations[0].oldValue.replace(CursorBlot.CONTENTS, '');
      let oldText = new Delta().insert(oldValue);
      let newText = new Delta().insert(textBlot.value());
      let diffDelta = new Delta().retain(index).concat(oldText.diff(newText, cursorIndex));
      change = diffDelta.reduce(function(delta, op) {
        if (op.insert) {
          return delta.insert(op.insert, formats);
        } else {
          return delta.push(op);
        }
      }, new Delta());
      this.delta = oldDelta.compose(change);
    } else if (change && mutations.length === 0) {
      // naive optimization
      this.delta = oldDelta.compose(deltaSinceLastUpdate);
      this.cleanDocumentDelta();
    } else {
      this.delta = this.getDelta();
      if (!change || !equal(oldDelta.compose(change), this.delta)) {
        change = oldDelta.diff(this.delta, cursorIndex);
      }
    }
    return change;
  }
}


function combineFormats(formats, combined) {
  return Object.keys(combined).reduce(function(merged, name) {
    if (formats[name] == null) return merged;
    if (combined[name] === formats[name]) {
      merged[name] = combined[name];
    } else if (Array.isArray(combined[name])) {
      if (combined[name].indexOf(formats[name]) < 0) {
        merged[name] = combined[name].concat([formats[name]]);
      }
    } else {
      merged[name] = [combined[name], formats[name]];
    }
    return merged;
  }, {});
}

function normalizeDelta(delta) {
  return delta.reduce(function(delta, op) {
    if (op.insert === 1) {
      let attributes = clone(op.attributes);
      delete attributes['image'];
      return delta.insert({ image: op.attributes.image }, attributes);
    }
    if (op.attributes != null && (op.attributes.list === true || op.attributes.bullet === true)) {
      op = clone(op);
      if (op.attributes.list) {
        op.attributes.list = 'ordered';
      } else {
        op.attributes.list = 'bullet';
        delete op.attributes.bullet;
      }
    }
    if (typeof op.insert === 'string') {
      let text = op.insert.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return delta.insert(text, op.attributes);
    }
    return delta.push(op);
  }, new Delta());
}


export default Editor;
