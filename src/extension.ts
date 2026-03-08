import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type ReloadSnippetsOptions = {
  preserveCurrentIndex?: boolean;
  showStatus?: boolean;
};

type ParsedSnippets = {
  snippets: string[];
  snippetStartLines: number[];
  totalLines: number;
};
class PredictiveTypingEngine {
  private enabled = false;
  private snippets: string[] = [];
  private currentSnippetIndex = 0;
  private currentOffset = 0;
  private snippetStartLines: number[] = [];
  private totalSnippetFileLines = 0;
  private suppressChangeEventDepth = 0;
  private syncExternalChanges = false;
  private triggerSuggest = true;
  private suggestDelayMs = 60;
  private autoDisableOnSnippetEnd = true;
  private queuedInput = "";
  private isFlushingInput = false;
  private suggestTimer: NodeJS.Timeout | undefined;
  private parameterHintsTimer: NodeJS.Timeout | undefined;
  private pendingIndentTrim = 0;
  private pendingExistingClosingTagRemainder = "";
  private progressFileSetting = "";
  private progressWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async init(): Promise<void> {
    await this.reloadSnippets();
    this.updateEnabledContext();
  }

  public async toggle(): Promise<void> {
    if (this.enabled) {
      this.disableMode("Predictive Fake Typing: OFF");
      return;
    }

    await this.reloadSnippets({ preserveCurrentIndex: true, showStatus: false });
    this.startCurrentSnippet(this.buildSnippetStatusMessage("Predictive Fake Typing: ON"));
  }

  public exit(): void {
    if (!this.enabled) {
      return;
    }

    this.disableMode("Predictive Fake Typing: OFF");
  }

  public async nextSnippet(): Promise<void> {
    await this.reloadSnippets({ preserveCurrentIndex: true, showStatus: false });
    if (!this.ensureSnippetNavigationAvailable()) {
      return;
    }

    this.currentSnippetIndex = (this.currentSnippetIndex + 1) % this.snippets.length;
    this.startCurrentSnippet(this.buildSnippetStatusMessage("Predictive Fake Typing: snippet"));
  }

  public async previousSnippet(): Promise<void> {
    await this.reloadSnippets({ preserveCurrentIndex: true, showStatus: false });
    if (!this.ensureSnippetNavigationAvailable()) {
      return;
    }

    this.currentSnippetIndex =
      (this.currentSnippetIndex - 1 + this.snippets.length) % this.snippets.length;
    this.startCurrentSnippet(this.buildSnippetStatusMessage("Predictive Fake Typing: snippet"));
  }

  private ensureSnippetNavigationAvailable(): boolean {
    if (this.snippets.length === 0) {
      vscode.window.showWarningMessage("Predictive Fake Typing: no snippets loaded.");
      return false;
    }

    if (this.snippets.length === 1) {
      vscode.window.showWarningMessage(
        "Predictive Fake Typing: only 1 snippet is loaded. Run 'Pick Snippets File' and then 'Reload Snippets' if you expected multiple sections."
      );
      return false;
    }

    return true;
  }

  public async reloadSnippets(options: ReloadSnippetsOptions = {}): Promise<void> {
    const { preserveCurrentIndex = false, showStatus = true } = options;
    const config = vscode.workspace.getConfiguration("predictiveFakeTyping");
    const filePathSetting = config.get<string>("snippetsFile", "predict-snippets.txt");
    const separator = config.get<string>("blockSeparator", "\n===\n");
    this.syncExternalChanges = config.get<boolean>("syncExternalChanges", true);
    this.triggerSuggest = config.get<boolean>("triggerSuggest", true);
    this.suggestDelayMs = Math.max(0, config.get<number>("suggestDelayMs", 60));
    this.autoDisableOnSnippetEnd = config.get<boolean>("autoDisableOnSnippetEnd", true);
    this.progressFileSetting = config.get<string>("progressFile", "");

    const filePath = this.resolvePath(filePathSetting);

    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const content = raw.replace(/\r\n/g, "\n");
      const previousSnippetIndex = this.currentSnippetIndex;
      const parsed = this.parseSnippets(content, separator);
      this.snippets = parsed.snippets;
      this.snippetStartLines = parsed.snippetStartLines;
      this.totalSnippetFileLines = parsed.totalLines;

      if (this.snippets.length === 0) {
        this.currentSnippetIndex = 0;
      } else if (preserveCurrentIndex) {
        this.currentSnippetIndex = Math.min(previousSnippetIndex, this.snippets.length - 1);
      } else {
        this.currentSnippetIndex = 0;
      }

      this.currentOffset = 0;
      this.pendingIndentTrim = 0;
      this.pendingExistingClosingTagRemainder = "";
      this.writeProgressMarker();

      if (showStatus) {
        vscode.window.setStatusBarMessage(
          `Predictive Fake Typing: loaded ${this.snippets.length} snippet(s)`,
          2500
        );
      }
    } catch (error) {
      this.snippets = [];
      this.snippetStartLines = [];
      this.totalSnippetFileLines = 0;
      this.currentSnippetIndex = 0;
      this.currentOffset = 0;
      this.pendingIndentTrim = 0;
      this.pendingExistingClosingTagRemainder = "";
      this.writeProgressMarker();

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

  public async pickProgressFile(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const selected = await vscode.window.showSaveDialog({
      title: "Select Predictive Progress File",
      saveLabel: "Use for progress output",
      defaultUri: workspaceFolder?.uri,
      filters: {
        "Text files": ["txt"],
        "All files": ["*"],
      },
    });

    if (!selected) {
      return;
    }

    const pickedPath = selected.fsPath;
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
    await config.update("progressFile", configPath, target);
    this.progressFileSetting = configPath;
    this.writeProgressMarker();
    vscode.window.setStatusBarMessage(
      `Predictive Fake Typing: progress file -> ${configPath}`,
      3000
    );
  }

  private startCurrentSnippet(statusMessage: string): void {
    this.ensureValidSnippetIndex();

    if (this.snippets.length === 0) {
      this.enabled = false;
      this.currentOffset = 0;
      this.pendingIndentTrim = 0;
      this.pendingExistingClosingTagRemainder = "";
      this.queuedInput = "";
      this.clearIntelliSenseTimers();
      this.updateEnabledContext();
      this.writeProgressMarker();
      vscode.window.showWarningMessage(
        "Predictive Fake Typing: no snippets loaded. Run 'Predictive Fake Typing: Reload Snippets' or check predictiveFakeTyping.snippetsFile."
      );
      return;
    }

    this.enabled = true;
    this.currentOffset = 0;
    this.pendingIndentTrim = 0;
    this.pendingExistingClosingTagRemainder = "";
    this.queuedInput = "";
    this.clearIntelliSenseTimers();
    this.updateEnabledContext();
    this.writeProgressMarker();
    vscode.window.setStatusBarMessage(statusMessage, 2000);
  }

  private disableMode(statusMessage: string): void {
    this.enabled = false;
    this.queuedInput = "";
    this.pendingIndentTrim = 0;
    this.pendingExistingClosingTagRemainder = "";
    this.clearIntelliSenseTimers();
    this.updateEnabledContext();
    this.writeProgressMarker();
    vscode.window.setStatusBarMessage(statusMessage, 2000);
  }

  private buildSnippetStatusMessage(prefix: string): string {
    if (this.snippets.length <= 1) {
      return prefix;
    }

    return `${prefix} ${this.currentSnippetIndex + 1}/${this.snippets.length}`;
  }

  private parseSnippets(content: string, separatorSetting: string): ParsedSnippets {
    const separator = this.normalizeSeparator(separatorSetting);
    const totalLines = content.length === 0 ? 0 : content.split("\n").length;

    if (separator.trim() === "===") {
      return this.parseLineSeparatedSnippets(content, totalLines);
    }

    return this.parseStringSeparatedSnippets(content, separator, totalLines);
  }

  private parseLineSeparatedSnippets(content: string, totalLines: number): ParsedSnippets {
    const snippets: string[] = [];
    const snippetStartLines: number[] = [];
    const lines = content.split("\n");
    let blockLines: string[] = [];
    let blockStartLine = 1;

    const flushBlock = (): void => {
      const rawBlock = blockLines.join("\n");
      this.pushParsedSnippet(snippets, snippetStartLines, rawBlock, blockStartLine);
      blockLines = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^[ \t]*===[ \t]*$/.test(line)) {
        flushBlock();
        blockStartLine = i + 2;
        continue;
      }

      blockLines.push(line);
    }

    flushBlock();
    return { snippets, snippetStartLines, totalLines };
  }

  private parseStringSeparatedSnippets(
    content: string,
    separator: string,
    totalLines: number
  ): ParsedSnippets {
    const snippets: string[] = [];
    const snippetStartLines: number[] = [];
    let cursor = 0;
    let blockStartLine = 1;

    while (cursor <= content.length) {
      const nextIndex = content.indexOf(separator, cursor);
      const blockEnd = nextIndex === -1 ? content.length : nextIndex;
      const rawBlock = content.slice(cursor, blockEnd);
      this.pushParsedSnippet(snippets, snippetStartLines, rawBlock, blockStartLine);

      if (nextIndex === -1) {
        break;
      }

      const consumed = content.slice(cursor, nextIndex + separator.length);
      blockStartLine += this.countNewlines(consumed);
      cursor = nextIndex + separator.length;
    }

    return { snippets, snippetStartLines, totalLines };
  }

  private pushParsedSnippet(
    snippets: string[],
    snippetStartLines: number[],
    rawBlock: string,
    rawStartLine: number
  ): void {
    const trimmed = rawBlock.trim();
    if (trimmed.length === 0) {
      return;
    }

    const leadingWhitespace = rawBlock.match(/^\s*/)?.[0] ?? "";
    const leadingNewlines = this.countNewlines(leadingWhitespace);
    snippets.push(trimmed);
    snippetStartLines.push(rawStartLine + leadingNewlines);
  }

  private countNewlines(text: string): number {
    return (text.match(/\n/g) ?? []).length;
  }

  private normalizeSeparator(separator: string): string {
    return separator.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  }

  private updateEnabledContext(): void {
    void vscode.commands.executeCommand("setContext", "predictiveFakeTyping.enabled", this.enabled);
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

    let insertedCount = 0;
    await this.runWithSuppressedChanges(async () => {
      for (let i = 0; i < input.length && this.enabled; i += 1) {
        const ch = this.nextPredictedCharacter();
        if (ch.length === 0) {
          break;
        }

        if (this.triggerSuggest && this.isSuggestionCommitCharacter(ch)) {
          await vscode.commands.executeCommand("hideSuggestWidget");
        }

        insertedCount += 1;

        if (this.pendingIndentTrim > 0) {
          if (this.isHorizontalWhitespace(ch)) {
            this.pendingIndentTrim -= 1;
            this.writeProgressMarker();
            continue;
          }
          this.pendingIndentTrim = 0;
        }

        if (await this.tryConsumeExistingAutoInsertedChar(ch)) {
          if (this.triggerSuggest) {
            this.scheduleIntelliSense(ch);
          }
          this.writeProgressMarker();
          continue;
        }

        await vscode.commands.executeCommand("default:type", { text: ch });
        if (ch === "\n") {
          this.updatePendingIndentTrimAfterNewline();
        }

        if (this.triggerSuggest) {
          this.scheduleIntelliSense(ch);
        }
        this.writeProgressMarker();
      }
    });

    if (!this.enabled && this.autoDisableOnSnippetEnd) {
      return;
    }

    if (insertedCount < input.length) {
      const remainingRaw = input.slice(insertedCount);
      if (remainingRaw.length > 0) {
        await vscode.commands.executeCommand("default:type", { text: remainingRaw });
      }
    }
  }

  private isHorizontalWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t";
  }

  private isClosingChar(ch: string): boolean {
    return ch === ")" || ch === "]" || ch === "}";
  }

  private isQuoteChar(ch: string): boolean {
    return ch === `"` || ch === "'" || ch === "`";
  }

  private async tryConsumeExistingAutoInsertedChar(ch: string): Promise<boolean> {
    if (await this.tryConsumePendingExistingClosingTagChar(ch)) {
      return true;
    }

    if (await this.tryStartConsumingExistingClosingTag(ch)) {
      return true;
    }

    if (await this.tryConsumeExistingQuote(ch)) {
      return true;
    }

    return this.tryConsumeExistingClosingChar(ch);
  }

  private async tryConsumePendingExistingClosingTagChar(ch: string): Promise<boolean> {
    if (this.pendingExistingClosingTagRemainder.length === 0) {
      return false;
    }

    if (ch !== this.pendingExistingClosingTagRemainder[0]) {
      this.pendingExistingClosingTagRemainder = "";
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || !editor.selection.isEmpty) {
      this.pendingExistingClosingTagRemainder = "";
      return false;
    }

    const cursor = editor.selection.active;
    const doc = editor.document;
    const offset = doc.offsetAt(cursor);
    if ((doc.getText().charAt(offset) ?? "") !== ch) {
      this.pendingExistingClosingTagRemainder = "";
      return false;
    }

    const target = doc.positionAt(offset + 1);
    editor.selection = new vscode.Selection(target, target);
    this.pendingExistingClosingTagRemainder = this.pendingExistingClosingTagRemainder.slice(1);
    return true;
  }

  private async tryStartConsumingExistingClosingTag(ch: string): Promise<boolean> {
    if (ch !== "<") {
      return false;
    }

    const segment = this.getCurrentClosingTagSegment();
    if (segment.length === 0) {
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || !editor.selection.isEmpty) {
      return false;
    }

    const cursor = editor.selection.active;
    const doc = editor.document;
    const text = doc.getText();
    const startOffset = doc.offsetAt(cursor);
    const endOffset = Math.min(text.length, startOffset + segment.length + 64);
    const visibleText = text.slice(startOffset, endOffset);
    const gapMatch = visibleText.match(/^[ \t\r\n]*/);
    const gapLength = gapMatch ? gapMatch[0].length : 0;

    if (visibleText.slice(gapLength, gapLength + segment.length) !== segment) {
      return false;
    }

    const target = doc.positionAt(startOffset + gapLength + 1);
    editor.selection = new vscode.Selection(target, target);
    this.pendingExistingClosingTagRemainder = segment.slice(1);
    return true;
  }

  private getCurrentClosingTagSegment(): string {
    const snippet = this.getCurrentSnippet();
    if (snippet.length === 0) {
      return "";
    }

    const start = Math.max(0, this.currentOffset - 1);
    const match = snippet.slice(start).match(/^<\/[A-Za-z0-9:_-]+\s*>/);
    return match ? match[0] : "";
  }

  private async tryConsumeExistingQuote(ch: string): Promise<boolean> {
    if (!this.isQuoteChar(ch)) {
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || !editor.selection.isEmpty) {
      return false;
    }

    const cursor = editor.selection.active;
    const doc = editor.document;
    const offset = doc.offsetAt(cursor);
    if ((doc.getText().charAt(offset) ?? "") !== ch) {
      return false;
    }

    const target = doc.positionAt(offset + 1);
    editor.selection = new vscode.Selection(target, target);
    return true;
  }

  private async tryConsumeExistingClosingChar(ch: string): Promise<boolean> {
    if (!this.isClosingChar(ch)) {
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || !editor.selection.isEmpty) {
      return false;
    }

    const cursor = editor.selection.active;
    const doc = editor.document;
    const text = doc.getText();
    const startOffset = doc.offsetAt(cursor);
    const endOffset = Math.min(text.length, startOffset + 240);

    for (let offset = startOffset; offset < endOffset; offset += 1) {
      const c = text[offset] ?? "";
      if (c === ch) {
        const target = doc.positionAt(offset + 1);
        editor.selection = new vscode.Selection(target, target);
        return true;
      }
      if (!this.isSkippableCloserGapChar(c)) {
        return false;
      }
    }

    return false;
  }

  private isSkippableCloserGapChar(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  private updatePendingIndentTrimAfterNewline(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.pendingIndentTrim = 0;
      return;
    }

    const cursor = editor.selection.active;
    const lineText = editor.document.lineAt(cursor.line).text;
    const prefix = lineText.slice(0, cursor.character);
    const match = prefix.match(/^[ \t]*/);
    this.pendingIndentTrim = match ? match[0].length : 0;
  }

  private writeProgressMarker(): void {
    const progressPath = this.resolveProgressFilePath();
    if (!progressPath) {
      return;
    }

    const marker = this.buildProgressMarker();
    this.progressWriteQueue = this.progressWriteQueue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(progressPath), { recursive: true });
        await fs.promises.writeFile(progressPath, marker, "utf8");
      })
      .catch((error) => {
        console.error("Predictive Fake Typing: failed to write progress marker", error);
      });
  }

  private buildProgressMarker(): string {
    const totalLines = this.totalSnippetFileLines;
    const snippet = this.getCurrentSnippet();
    if (snippet.length === 0) {
      return `0,${totalLines}`;
    }

    const safeOffset = Math.max(0, Math.min(this.currentOffset, snippet.length));
    let currentLine = this.getCurrentSnippetStartLine();
    for (let i = 0; i < safeOffset; i += 1) {
      if (snippet[i] === "\n") {
        currentLine += 1;
      }
    }

    return `${currentLine},${totalLines}`;
  }

  private getCurrentSnippetStartLine(): number {
    if (this.currentSnippetIndex < 0 || this.currentSnippetIndex >= this.snippetStartLines.length) {
      return 0;
    }

    return this.snippetStartLines[this.currentSnippetIndex] ?? 0;
  }

  private resolveProgressFilePath(): string | undefined {
    const configPath = this.progressFileSetting.trim();
    if (configPath.length > 0) {
      return this.resolvePath(configPath);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return path.join(workspaceFolder.uri.fsPath, ".predictive-fake-typing-progress.txt");
    }

    return path.join(this.context.globalStorageUri.fsPath, "predictive-fake-typing-progress.txt");
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
        this.pendingIndentTrim = 0;
        this.pendingExistingClosingTagRemainder = "";
        this.clearIntelliSenseTimers();
        this.updateEnabledContext();
        this.writeProgressMarker();
        vscode.window.setStatusBarMessage(
          "Predictive Fake Typing: snippet finished, OFF",
          2500
        );
      } else {
        this.currentOffset = 0;
        this.pendingIndentTrim = 0;
        this.pendingExistingClosingTagRemainder = "";
        this.writeProgressMarker();
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

    if (this.matchesSnippetFromCurrentOffset(inserted, snippet)) {
      this.advanceOffset(inserted.length, snippet.length);
      this.writeProgressMarker();
      return;
    }

    if (change.rangeLength > 0) {
      const replacedLen = change.rangeLength;
      const replacedExpected = this.getSnippetBackwardSegment(replacedLen, snippet);
      if (inserted.startsWith(replacedExpected)) {
        const addedSuffix = inserted.slice(replacedLen);
        if (addedSuffix.length > 0 && this.matchesSnippetFromCurrentOffset(addedSuffix, snippet)) {
          this.advanceOffset(addedSuffix.length, snippet.length);
          this.writeProgressMarker();
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

    const last = insertedText[insertedText.length - 1] ?? "";
    return last === ".";
  }

  private isSuggestionCommitCharacter(ch: string): boolean {
    return /[,\)\]\};\n]/.test(ch);
  }

  private scheduleIntelliSense(insertedText: string): void {
    const shouldSuggestNow = this.shouldTriggerSuggest(insertedText);
    const shouldTriggerParameterHints =
      insertedText.includes("(") || insertedText.includes(",");

    if (shouldSuggestNow) {
      this.scheduleSuggest();
    }
    if (shouldTriggerParameterHints) {
      this.scheduleParameterHints();
    }
  }

  private scheduleSuggest(): void {
    if (this.suggestTimer) {
      clearTimeout(this.suggestTimer);
    }

    this.suggestTimer = setTimeout(() => {
      void vscode.commands.executeCommand("editor.action.triggerSuggest");
    }, this.suggestDelayMs);
  }

  private scheduleParameterHints(): void {
    if (this.parameterHintsTimer) {
      clearTimeout(this.parameterHintsTimer);
    }

    this.parameterHintsTimer = setTimeout(() => {
      void vscode.commands.executeCommand("editor.action.triggerParameterHints");
    }, this.suggestDelayMs + 20);
  }

  private clearIntelliSenseTimers(): void {
    if (this.suggestTimer) {
      clearTimeout(this.suggestTimer);
      this.suggestTimer = undefined;
    }
    if (this.parameterHintsTimer) {
      clearTimeout(this.parameterHintsTimer);
      this.parameterHintsTimer = undefined;
    }
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
    vscode.commands.registerCommand("predictiveFakeTyping.toggle", async () => {
      await engine.toggle();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.exit", () => {
      engine.exit();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.nextSnippet", async () => {
      await engine.nextSnippet();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("predictiveFakeTyping.previousSnippet", async () => {
      await engine.previousSnippet();
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
    vscode.commands.registerCommand("predictiveFakeTyping.pickProgressFile", async () => {
      await engine.pickProgressFile();
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
