// @file: tools/src/tools/ToolSearch/prompt.ts
// Prompt constants for ToolSearch tool.

export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

export const DESCRIPTION =
  '- Searches for tools by keyword or selects deferred tools by name\n' +
  '- Two modes: "select:Name1,Name2" for direct selection, or keyword search for discovery\n' +
  '- Returns matching tool names; the caller should then use those tools directly\n' +
  '- Required when the model needs to use a tool that was loaded with defer_loading';
