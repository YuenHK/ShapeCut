import { useEffect, useMemo, useRef } from 'react';
import { createOutlinePackage } from '../export/outline-package';
import { createGeometryWorkerClient, type GeometryClient } from '../workers/geometry-client';
import { OneClickConverter, type OneClickConverterServices, type OutlineDownloads } from './OneClickConverter';

function safeBaseName(fileName = 'model.stl'): string {
  return fileName.replace(/^.*[\\/]/u, '').replace(/\.stl$/iu, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-') || 'model';
}

function objectUrl(content: BlobPart, type: string, fileName: string) {
  return { href: URL.createObjectURL(new Blob([content], { type })), fileName };
}

export function packageDownloads(result: Parameters<typeof createOutlinePackage>[0], fileName?: string): Promise<OutlineDownloads> {
  return createOutlinePackage(result).then((files) => {
    const base = safeBaseName(fileName);
    return {
      zip: objectUrl(files.zip as BlobPart, 'application/zip', `${base}-shapecut.zip`),
      svg: objectUrl(files.cutSvg, 'image/svg+xml;charset=utf-8', `${base}-cut.svg`),
      dxf: objectUrl(files.cutDxf, 'application/dxf;charset=utf-8', `${base}-cut.dxf`),
      pdf: objectUrl(files.previewPdf as BlobPart, 'application/pdf', `${base}-preview.pdf`),
      json: objectUrl(files.manifestJson, 'application/json;charset=utf-8', `${base}-manifest.json`),
    };
  });
}

export function createOneClickServices(
  getGeometry: () => GeometryClient,
  cancel = () => getGeometry().cancelActive(),
): OneClickConverterServices {
  return {
    cancel,
    convert: (bytes, onProgress) => getGeometry().convertAutomatically({ bytes }, onProgress),
    package: packageDownloads,
  };
}

export function App({ services: suppliedServices }: { readonly services?: OneClickConverterServices }) {
  const geometryRef = useRef<GeometryClient | undefined>(undefined);
  const services = useMemo(() => suppliedServices ?? createOneClickServices(
    () => geometryRef.current ??= createGeometryWorkerClient(),
    () => geometryRef.current?.cancelActive(),
  ), [suppliedServices]);
  useEffect(() => () => geometryRef.current?.dispose(), []);
  return (
    <div className="app-shell">
      <header className="site-header"><a className="brand" href="./" aria-label="ShapeCut 首頁"><span aria-hidden="true">S</span>ShapeCut</a><p>私隱優先 · 本機處理</p></header>
      <main><OneClickConverter services={services} /></main>
      <footer>輸出為通用外形，不包含雷射功率或速度。正式製作前請先試切。</footer>
    </div>
  );
}
