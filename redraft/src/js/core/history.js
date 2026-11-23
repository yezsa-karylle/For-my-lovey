// Unlimited undo/redo built on invertible ops. Every applied op (including
// undos) is appended to project.journal with a timestamp for the Replay video.
import { applyOp, invertOp } from './model.js';

export class History {
  constructor(project, onChange = () => {}) {
    this.project = project;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
    if (!project.journal) project.journal = [];
  }

  /** Apply op. `meta` (e.g. {anim, dur}) is kept on the journal entry for replay. */
  do(op, meta = {}) {
    applyOp(this.project, op);
    this.undoStack.push(op);
    this.redoStack.length = 0;
    this._log(op, meta);
    this.onChange(op, 'do');
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    const inv = invertOp(op);
    applyOp(this.project, inv);
    this.redoStack.push(op);
    this._log(inv, { undo: true });
    this.onChange(inv, 'undo');
    return inv;
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return null;
    applyOp(this.project, op);
    this.undoStack.push(op);
    this._log(op, { redo: true });
    this.onChange(op, 'redo');
    return op;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _log(op, meta) {
    this.project.journal.push({ t: Date.now(), op, ...meta });
  }
}
