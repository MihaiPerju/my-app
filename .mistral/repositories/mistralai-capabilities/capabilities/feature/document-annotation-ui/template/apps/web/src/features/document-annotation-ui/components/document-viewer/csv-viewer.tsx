export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  isTruncated: boolean;
  error?: string;
}

export interface CsvViewerProps {
  csv: ParsedCsv;
}

export function CsvViewer({ csv }: CsvViewerProps) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {csv.headers.map((header, index) => (
            <th
              key={index}
              className="border-border bg-muted text-foreground border px-3 py-2 text-left font-medium whitespace-nowrap"
            >
              {header || <span className="text-muted-foreground">—</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {csv.rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="hover:bg-muted/40 transition-colors">
            {row.map((cell, colIndex) => (
              <td
                key={colIndex}
                className="border-border text-foreground max-w-xs truncate border px-3 py-2"
                title={cell}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
