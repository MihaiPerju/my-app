const FENCE = "`".repeat(32);

export const commonmarkSampleSpec = `# Tabs

${FENCE} example
line 1
.
<p>line 1</p>
${FENCE}

## Links

${FENCE} example
[x](y)
.
<p><a href="y">x</a></p>
${FENCE}
`;

export const gfmExtensionsSampleSpec = `## Tables

${FENCE} example table strikethrough
| a | b |
| - | - |
.
<table></table>
${FENCE}
`;
