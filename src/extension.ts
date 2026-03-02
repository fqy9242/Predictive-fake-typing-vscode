import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

class PredictiveTypingEngine {
  private enabled = false;
  private snippets: string[] = [];
  private currentSnippetIndex = 0;
  private currentOffset = 0;
  private suppressChangeEventDepth = 0;
  private syncExternalChanges = false;
  private triggerSuggest = true;
  private autoDisableOnSnippetEnd = true;
  private queuedInput = "";
  private isFlushingInput = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async init(): Promise<void> {
    await this.reloadSnippets();
  }

  public toggle(): void {
    this.enabled = !this.enabled;

    if (this.enabled) {
      this.currentOffset = 0;
      this.ensureValidSnippetIndex();
      if (this.snippets.length === 0) {
        vscode.window.showWarningMessage(
          "Predictive Fake Typing: no snippets loaded. Run 'Predictive Fake Typing: Reload Snippets' or check predictiveFakeTyping.snippetsFile."
        );
      }
      vscode.window.setStatusBarMessage("Predictive Fake Typing: ON", 2000);
      return;
    }

    this.queuedInput = "";
    vscode.window.setStatusBarMessage("Predictive Fake Typing: OFF", 2000);
  }

  public nextSnippet(): void {
    if (this.snippets.length === 0) {
      vscode.window.showWarningMessage("No snippets loaded.");
      return;
    }

    this.currentSnippetIndex = (this.currentSnippetIndex + 1) % this.snippets.length;
    this.currentOffset = 0;

    vscode.window.setStatusBarMessage(
      `Predictive Fake Typing: switched to snippet #${this.currentSnippetIndex + 1}`,
      2000
    );
  }

  public async reloadSnippets(): Promise<void> {
    const config = vscode.workspace.getConfiguration("predictiveFakeTyping");
    const filePathSetting = config.get<string>("snippetsFile", "predict-snippets.txt");
    const separator = config.get<string>("blockSeparator", "\n===\n");
    this.syncExternalChanges = config.get<boolean>("syncExternalChanges", true);
    this.triggerSuggest = config.get<boolean>("triggerSuggest", true);
    this.autoDisableOnSnippetEnd = config.get<boolean>("autoDisableOnSnippetEnd", true);

    const filePath = this.resolvePath(filePathSetting);

    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const content = raw.replace(/\r\n/g, "\n");
      this.snippets = content
        .split(separator)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      this.currentSnippetIndex = 0;
      this.currentOffset = 0;

      vscode.window.setStatusBarMessage(
        `Predictive Fake Typing: loaded ${this.snippets.length} snippet(s)`,
        2500
      );
    } catch (error) {
      this.snippets = [];
      this.currentSnippetIndex = 0;
      this.currentOffset = 0;

      const detail = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to load snippets from ${filePath}: ${detail}`);
    }
  }

  public async handleType(args: { text: string }): Promise<void> {
    const input = typeof args?.text === "string" ? args.text : "";

    if (!this.enabled || input.length === 0 || this.snippets.length === 0) {
      await vscode.commands.executeCommand("default:type", args);
      return;
    }

    this.queuedInput += input;
    if (!this.isFlushingInput) {
      void this.flushQueuedInput();
    }
  }

  public async pickSnippetsFile(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Use as snippet source",
      title: "Select Predictive Snippets File",
      filters: {
        "Text / Code": ["txt", "code-snippets", "json", "md", "py", "js", "ts", "vue", "yaml", "yml"],
      },
    });

    if (!selected || selected.length === 0) {
      return;
    }

    const pickedPath = selected[0].fsPath;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const target = workspaceFolder
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    let configPath = pickedPath;
    if (workspaceFolder) {
      const rel = path.relative(workspaceFolder.uri.fsPath, pickedPath);
      if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        configPath = rel.replace(/\\/g, "/");
      }
    }

    const config = vscode.workspace.getConfiguration("predictiveFakeTyping");
    await config.update("snippetsFile", configPath, target);
    await this.reloadSnippets();
    vscode.window.setStatusBarMessage(
      `Predictive Fake Typing: snippets file -> ${configPath}`,
      3000
    );
  }

  private async flushQueuedInput(): Promise<void> {
    if (this.isFlushingInput) {
      return;
    }

    this.isFlushingInput = true;
    try {
      while (this.queuedInput.length > 0) {
        const chunk = this.queuedInput;
        this.queuedInput = "";
        await this.applyPredictedType(chunk);
      }
    } catch (error) {
      console.error("Predictive Fake Typing: failed while flushing input", error);
    } finally {
      this.isFlushingInput = false;
      if (this.queuedInput.length > 0) {
        void this.flushQueuedInput();
      }
    }
  }

  private async applyPredictedType(input: string): Promise<void> {
    if (input.length === 0 || !this.enabled) {
      return;
    }

    if (this.snippets.length === 0) {
      await vscode.commands.executeCommand("default:type", { text: input });
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const predicted = this.nextPredictedChunk(input.length);
    await this.runWithSuppressedChanges(async () => {
      const ok = await editor.edit(
        (builder) => {
          for (const selection of editor.selections) {
            builder.replace(selection, predicted);
          }
        },
        {
          undoStopBefore: false,
          undoStopAfter: false,
        }
      );

      if (!ok) {
        await vscode.commands.executeCommand("default:type", { text: predicted });
      }
    });

    if (this.triggerSuggest && this.shouldTriggerSuggest(predicted)) {
      void vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  }

  public onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (!this.enabled || this.isSuppressingChangeEvents() || !this.syncExternalChanges) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    if (event.document.uri.toString() !== editor.document.uri.toString()) {
      return;
    }

    if (this.snippets.length === 0) {
      return;
    }

    for (const change of event.contentChanges) {
      if (change.text.length === 0) {
        continue;
      }
      this.alignOffsetWithExternalInsertion(change);
    }
  }

  private nextPredictedChunk(length: number): string {
    let output = "";
    for (let i = 0; i < length; i += 1) {
      if (!this.enabled) {
        break;
      }
      output += this.nextPredictedCharacter();
    }
    return output;
  }

  private nextPredictedCharacter(): string {
    this.ensureValidSnippetIndex();

    const snippet = this.getCurrentSnippet();
    if (snippet.length === 0) {
      return "";
    }

    const ch = snippet[this.currentOffset] ?? "";
    this.currentOffset += 1;

    if (this.currentOffset >= snippet.length) {
      if (this.autoDisableOnSnippetEnd) {
        this.enabled = false;
        this.queuedInput = "";
        vscode.window.setStatusBarMessage(
          "Predictive Fake Typing: snippet finished, OFF",
          2500
        );
      } else {
        this.currentOffset = 0;
      }
    }

    return ch;
  }

  private alignOffsetWithExternalInsertion(
    change: vscode.TextDocumentContentChangeEvent
  ): void {
    const inserted = change.text.replace(/\r\n/g, "\n");
    if (inserted.length === 0) {
      return;
    }

    const snippet = this.getCurrentSnippet();
    if (snippet.length === 0) {
      return;
    }

    // Only align when external insertion exactly matches the expected stream.
    // Fuzzy jumps can skip characters and cause visible "missing letters".
    if (this.matchesSnippetFromCurrentOffset(inserted, snippet)) {
      this.advanceOffset(inserted.length, snippet.length);
      return;
    }

    // Handle completion-accept case where VSCode replaces an existing prefix
    // with a longer completed token (e.g. "pri" -> "print").
    if (change.rangeLength > 0) {
      const replacedLen = change.rangeLength;
      const replacedExpected = this.getSnippetBackwardSegment(replacedLen, snippet);
      if (inserted.startsWith(replacedExpected)) {
        const newlyAdded = inserted.length - replacedLen;
        if (newlyAdded > 0) {
          this.advanceOffset(newlyAdded, snippet.length);
        }
      }
    }
  }

  private advanceOffset(step: number, snippetLength: number): void {
    if (step <= 0 || snippetLength <= 0) {
      return;
    }
    this.currentOffset = (this.currentOffset + step) % snippetLength;
  }

  private matchesSnippetFromCurrentOffset(text: string, snippet: string): boolean {
    if (text.length === 0 || snippet.length === 0) {
      return false;
    }

    for (let i = 0; i < text.length; i += 1) {
      const expected = snippet[(this.currentOffset + i) % snippet.length] ?? "";
      if (text[i] !== expected) {
        return false;
      }
    }

    return true;
  }

  private getSnippetBackwardSegment(length: number, snippet: string): string {
    if (length <= 0 || snippet.length === 0) {
      return "";
    }

    let result = "";
    for (let i = length; i > 0; i -= 1) {
      const idx = (this.currentOffset - i + snippet.length) % snippet.length;
      result += snippet[idx] ?? "";
    }
    return result;
  }

  private shouldTriggerSuggest(insertedText: string): boolean {
    if (insertedText.length === 0) {
      return false;
    }

    // Trigger suggestion only when it looks like an identifier path.
    const last = insertedText[insertedText.length - 1] ?? "";
    return /[A-Za-z0-9_.]/.test(last);
  }

  private isSuppressingChangeEvents(): boolean {
    return this.suppressChangeEventDepth > 0;
  }

  private async runWithSuppressedChanges<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressChangeEventDepth += 1;
    try {
      return await fn();
    } finally {
      this.suppressChangeEventDepth -= 1;
    }
  }

  private getCurrentSnippet(): string {
    this.ensureValidSnippetIndex();
    return this.snippets[this.currentSnippetIndex] ?? "";
  }

  private ensureValidSnippetIndex(): void {
    if (this.snippets.length === 0) {
      this.currentSnippetIndex = 0;
      return;
    }

    if (this.currentSnippetIndex < 0 || this.currentSnippetIndex >= this.snippets.length) {
      this.currentSnippetIndex = 0;
    }
  }

  private resolvePath(configPath: string): string {
    if (path.isAbsolute(configPath)) {
      return configPath;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const extensionCandidate = path.join(this.context.extensionPath, configPath);
    if (workspaceFolder) {
      const workspaceCandidate = path.join(workspaceFolder.uri.fsPath, configPath);
      if (fs.existsSync(workspaceCandidate)) {
        return workspaceCandidate;
      }
      if (fs.existsSync(extensionCandidate)) {
        return extensionCandidate;
      }
      return workspaceCandidate;
    }

    return extensionCandidate;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const engine = new PredictiveTypingEngine(context);
  await engine.init();

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.toggle", () => {
      engine.toggle();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.nextSnippet", () => {
      engine.nextSnippet();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.reload", async () => {
      await engine.reloadSnippets();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.pickSnippetsFile", async () => {
      await engine.pickSnippetsFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("type", async (args: { text: string }) => {
      await engine.handleType(args);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      engine.onDidChangeTextDocument(event);
    })
  );
}

export function deactivate(): void {
  // No resources to dispose explicitly.
}
