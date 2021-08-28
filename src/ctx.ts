import {
  commands,
  Disposable,
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  services,
  TextDocument,
  window,
  workspace,
} from 'coc.nvim';
import executable from 'executable';
import * as fs from 'fs-extra';
import versionCompare from 'node-version-compare';
import path from 'path';
import { Config } from './config';
import { downloadServer, getLatestRelease } from './downloader';
import { InlayHintsController } from './inlay_hints';

export type LuaDocument = TextDocument & { languageId: 'lua' };
export function isLuaDocument(document: TextDocument): document is LuaDocument {
  const ret = document.languageId === 'lua';
  return ret;
}

export type Cmd = (...args: any[]) => unknown;

export class Ctx {
  client!: LanguageClient;
  public readonly config = new Config();
  private inlayHintsController: InlayHintsController;

  constructor(public readonly extCtx: ExtensionContext) {
    this.inlayHintsController = new InlayHintsController(this);
    this.extCtx.subscriptions.push(this.inlayHintsController);
  }

  registerCommand(name: string, factory: (ctx: Ctx) => Cmd, internal = false) {
    const fullName = `sumneko-lua.${name}`;
    const cmd = factory(this);
    const d = commands.registerCommand(fullName, cmd, null, internal);
    this.extCtx.subscriptions.push(d);
  }

  get subscriptions(): Disposable[] {
    return this.extCtx.subscriptions;
  }

  resolveBin(): [string, string[]] | undefined {
    const platform = process.platform;
    const serverDir = path.join(this.extCtx.storagePath, 'sumneko-lua-ls', 'extension', 'server');
    const bin = path.join(
      serverDir,
      'bin',
      platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux',
      platform === 'win32' ? 'lua-language-server.exe' : 'lua-language-server'
    );
    console.log(bin);
    if (!fs.existsSync(bin)) {
      return;
    }

    if (!executable.sync(bin)) {
      window.showMessage(`${bin} is not executable`, 'error');
      return;
    }

    return [bin, ['-E', path.join(serverDir, 'main.lua'), `--locale=${this.config.locale}`]];
  }

  async checkUpdate() {
    const latest = await getLatestRelease();
    if (!latest) {
      return;
    }

    let old = '';
    try {
      const packageJson = path.join(this.extCtx.storagePath, 'sumneko-lua-ls', 'extension', 'package.json');
      const packageData = await fs.readJson(packageJson);
      old = packageData.version;
    } catch (err) {
      console.error(err);
      return;
    }

    const latestV = latest.version.match(/\d.*/);
    if (!latestV) {
      return;
    }

    if (versionCompare(latestV[0], old) <= 0) {
      return;
    }

    const msg = `Sumneko lua-language-server has a new release: ${latest.version}, you're using v${old}.`;
    if (this.config.prompt) {
      const ret = await window.showQuickpick(['Download the latest server', 'Cancel'], msg);
      if (ret === 0) {
        if (process.platform === 'win32') {
          await this.client.stop();
        }
        try {
          await downloadServer(this.extCtx, latest);
        } catch (e) {
          console.error(e);
          window.showMessage('Upgrade server failed', 'error');
          return;
        }
        await this.client.stop();
        this.client.start();
      } else {
        window.showMessage(`You can run ':CocCommand sumneko-lua.install' to upgrade server manually`);
      }
    } else {
      window.showMessage(`${msg} Run :CocCommand sumneko-lua.install to upgrade`);
    }
  }

  async startServer() {
    const bin = this.resolveBin();
    if (!bin) {
      return;
    }

    const [command, args] = bin;

    const serverOptions: ServerOptions = { command, args };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ language: 'lua' }],
      middleware: {
        workspace: {
          configuration: async (params, token, next) => {
            const result = await next(params, token);

            if (!this.config.nvimLuaDev || !Array.isArray(result)) {
              return result;
            }

            const sectionIndex = params.items.findIndex((item) => {
              if (item.section == 'Lua') {
                return true;
              }
            });

            if (sectionIndex == -1) {
              return result;
            }

            const configuration = result[sectionIndex];

            const library = configuration.workspace.library || [];

            const runtime = await workspace.nvim.call('expand', ['$VIMRUNTIME/lua']);
            if (!library.includes(runtime)) {
              library.push(runtime);
            }
            const types = `${path.dirname(path.dirname(__filename))}/nvim_lua_types`;
            if (!library.includes(types)) {
              library.push(types);
            }

            configuration.workspace.library = library;

            result[sectionIndex] = configuration;

            return result;
          },
        },
      },
    };

    const client = new LanguageClient('sumneko-lua', 'Sumneko Lua Language Server', serverOptions, clientOptions);
    this.extCtx.subscriptions.push(services.registLanguageClient(client));
    await client.onReady();
    this.client = client;
  }

  async activateInlayHints() {
    await workspace.nvim.command('hi default link CocLuaTypeHint  CocCodeLens');
    await workspace.nvim.command('hi default link CocLuaParamHint CocCodeLens');

    if (this.config.inlayHints) {
      this.inlayHintsController.activate();
    }
  }
}
