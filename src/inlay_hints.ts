import { Disposable, Document, events, Position, Range, workspace } from 'coc.nvim';
import { Ctx, isLuaDocument } from './ctx';

const inlayHintsNS = workspace.createNameSpace('lua-inlay-hint');

const enum HintKind {
  TypeHint = 1,
  ParamHint = 2,
}

export interface InlayHint {
  kind: HintKind;
  pos: Position;
  text: string;
}

export class InlayHintsController implements Disposable {
  private readonly disposables: Disposable[] = [];
  private inlayHintsEnabled: boolean;
  private inlayTypeHintsPrefix: string;
  private inlayParamHintsPrefix: string;
  private inlayHintsTrimSemicolon: boolean;

  constructor(private readonly ctx: Ctx) {
    const inlayHints = ctx.config.inlayHints;
    this.inlayHintsEnabled = !!inlayHints.enable;
    this.inlayTypeHintsPrefix = inlayHints.typeHintsPrefix;
    this.inlayParamHintsPrefix = inlayHints.paramHintsPrefix;
    this.inlayHintsTrimSemicolon = inlayHints.trimSemicolon;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  async activate() {
    events.on('InsertLeave', async (bufnr) => {
      const doc = workspace.getDocument(bufnr);
      if (doc && isLuaDocument(doc.textDocument)) {
        this.fetchAndRenderHints(doc);
      }
    });

    workspace.onDidChangeTextDocument(
      (e) => {
        const doc = workspace.getDocument(e.bufnr);
        if (doc && isLuaDocument(doc.textDocument)) {
          if (workspace.insertMode && !this.ctx.config.inlayHints.refreshOnInsertMode) {
            return;
          }
          this.fetchAndRenderHints(doc);
        }
      },
      this,
      this.disposables
    );

    workspace.onDidOpenTextDocument(
      (e) => {
        if (e && isLuaDocument(e)) {
          const doc = workspace.getDocument(e.uri);
          this.fetchAndRenderHints(doc);
        }
      },
      this,
      this.disposables
    );

    const currentDoc = await workspace.document;
    if (isLuaDocument(currentDoc.textDocument)) {
      this.fetchAndRenderHints(currentDoc);
    }
  }

  private async fetchAndRenderHints(doc: Document) {
    if (!this.inlayHintsEnabled) return;
    if (doc && isLuaDocument(doc.textDocument)) {
      this.fetchHints(doc).then(async (hints) => {
        if (!hints) return;
        this.renderHints(doc, hints);
      });
    }
  }

  private async fetchHints(doc: Document): Promise<null | InlayHint[]> {
    return this.ctx.client.sendRequest('$/requestHint', {
      textDocument: doc.textDocument,
      range: Range.create(0, 0, doc.lineCount, 0),
    });
  }

  private async renderHints(doc: Document, hints: InlayHint[]) {
    console.log(hints);
    doc.buffer.clearNamespace(inlayHintsNS);

    const newHints: { [key: string]: { typeHints: string[]; paramHints: string[] } } = {};

    for (const hint of hints) {
      const line = hint.pos.line.toString();
      newHints[line] = newHints[line] ? newHints[line] : { typeHints: [], paramHints: [] };

      if (hint.kind === HintKind.TypeHint) {
        newHints[line].typeHints.push(this.inlayHintsTrimSemicolon ? hint.text.replace(':', '') : hint.text);
      } else if (hint.kind === HintKind.ParamHint) {
        newHints[line].paramHints.push(this.inlayHintsTrimSemicolon ? hint.text.replace(':', '') : hint.text);
      }
    }

    Object.keys(newHints).forEach((line) => {
      const chunks: [string, string][] = [];

      const { paramHints, typeHints } = newHints[line];

      if (paramHints.length > 0) {
        chunks.push([` ${this.inlayParamHintsPrefix}(${paramHints.join(', ')})`, 'CocLuaParamHint']);
      }

      if (typeHints.length > 0) {
        let padding = '';
        if (chunks.length > 0) {
          padding = ' ';
        }
        chunks.push([`${padding}${this.inlayTypeHintsPrefix}${typeHints.join(', ')}`, 'CocLuaTypeHint']);
      }

      doc.buffer.setVirtualText(inlayHintsNS, Number(line), chunks, {});
    });
  }
}
