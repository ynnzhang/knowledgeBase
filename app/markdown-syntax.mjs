import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly';

// Parse and serialize Chinese emphasis without inserting spaces into the text.
export const cjkSyntax = cjkFriendlyExtension();
export const cjkSerialization = cjkFriendlyToMarkdown();
