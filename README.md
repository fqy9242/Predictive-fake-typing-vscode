# Predictive Fake Typing (VSCode Extension)

## Features
- Load code snippets from a file (default: `predict-snippets.txt`)
- Toggle fake typing mode with a hotkey
- When enabled, each keystroke outputs the next character from the target snippet
- Automatically turns mode off when current snippet is fully typed (configurable)
- Pick snippets file quickly from a hotkey

## Hotkeys
- `PgUp`: Toggle fake typing mode
- `Ctrl+Shift+Alt+N`: Switch to next snippet
- `F6`: Reload snippets file
- `F7`: Pick snippets file

## Settings
Configure in VSCode `settings.json`:

```json
{
  "predictiveFakeTyping.snippetsFile": "predict-snippets.txt",
  "predictiveFakeTyping.blockSeparator": "\\n===\\n",
  "predictiveFakeTyping.syncExternalChanges": true,
  "predictiveFakeTyping.triggerSuggest": true,
  "predictiveFakeTyping.autoDisableOnSnippetEnd": true
}
```

## Snippet File Format
Use `\n===\n` to separate snippets, for example:

```txt
function hello() {
  console.log("hello");
}
===
const sum = (a, b) => a + b;
```

## Run in Dev
1. `npm install`
2. `npm run compile`
3. Press `F5` in VSCode to start Extension Development Host
