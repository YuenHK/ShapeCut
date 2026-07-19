export type ImportStepProps = {
  readonly file?: File;
  readonly busy: boolean;
  readonly onFile: (file: File | undefined) => void;
  readonly onAnalyze: () => void;
};

export function ImportStep({ file, busy, onFile, onAnalyze }: ImportStepProps) {
  return (
    <section aria-labelledby="import-title">
      <h2 id="import-title">匯入與修復</h2>
      <label>STL 模型檔案<input aria-label="STL 模型檔案" type="file" accept=".stl,model/stl" onChange={(event) => onFile(event.currentTarget.files?.[0])} /></label>
      {file && <p>{file.name}</p>}
      <button type="button" disabled={!file || busy} onClick={onAnalyze}>{busy ? '分析中…' : '分析模型'}</button>
    </section>
  );
}
