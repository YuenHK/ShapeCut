import { useEffect, useMemo, useRef, useState } from 'react';
import { createGeometryWorkerClient, type GeometryClient } from '../workers/geometry-client';
import type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { OutlineArtifactError, type OutlineArtifactId } from '../workers/geometry-api';
import { OneClickConverter, type OneClickConverterServices, type OutlineDownloads } from './OneClickConverter';
import { listMaterialCatalog, type MaterialRepositoryPort } from './material-catalog';
import { MaterialRepository } from '../persistence/material-repository';
import type { MaterialProfileV1 } from '../domain/materials/schema';

function objectUrl(content: BlobPart, type: string, fileName: string) {
  return { href: URL.createObjectURL(new Blob([content], { type })), fileName };
}

export type OutlineDownloadContents = {
  readonly zip: Uint8Array;
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly explodedViewPdf: Uint8Array;
  readonly launcherCouponSvg: string;
};

export function createDownloadUrls(files: OutlineDownloadContents, _fileName?: string): OutlineDownloads {
  const created: string[] = [];
  let activeArtifact: OutlineArtifactId = 'shapecut-files.zip';
  const make = (content: BlobPart, type: string, name: OutlineArtifactId) => {
    activeArtifact = name;
    const download = objectUrl(content, type, name);
    created.push(download.href);
    return download;
  };
  try {
    return {
      zip: make(files.zip as BlobPart, 'application/zip', 'shapecut-files.zip'),
      svg: make(files.cutSvg, 'image/svg+xml;charset=utf-8', 'cut-and-engrave.svg'),
      dxf: make(files.cutDxf, 'application/dxf;charset=utf-8', 'cut-and-engrave.dxf'),
      previewPdf: make(files.previewPdf as BlobPart, 'application/pdf', 'preview.pdf'),
      explodedPdf: make(files.explodedViewPdf as BlobPart, 'application/pdf', 'exploded-view.pdf'),
      launcherCoupon: make(files.launcherCouponSvg, 'image/svg+xml;charset=utf-8', 'launcher-fit-coupon.svg'),
    };
  } catch (error) {
    for (const href of created) {
      try { URL.revokeObjectURL(href); } catch { /* Preserve the creation failure after best-effort cleanup. */ }
    }
    if (error instanceof OutlineArtifactError) throw error;
    throw new OutlineArtifactError(activeArtifact, { cause: error });
  }
}

export function createOneClickServices(
  getGeometry: () => GeometryClient,
  cancel = () => getGeometry().cancelActive(),
): OneClickConverterServices {
  return {
    cancel,
    present: (bytes: ArrayBuffer) => getGeometry().createStlPresentation(bytes),
    convert: (bytes: ArrayBuffer, material: ManufacturingGeometryProfile, launcherFitOffsetMm, onProgress) => getGeometry().convertAutomatically({
      bytes,
      material,
      launcherFitOffsetMm,
    }, onProgress),
    package: (result, fileName) => getGeometry().packageOutline(result).then((files) => createDownloadUrls(files, fileName)),
  };
}

export function App({
  services: suppliedServices,
  materialRepository: suppliedMaterialRepository,
}: {
  readonly services?: OneClickConverterServices;
  readonly materialRepository?: MaterialRepositoryPort;
}) {
  const geometryRef = useRef<GeometryClient | undefined>(undefined);
  const services = useMemo(() => suppliedServices ?? createOneClickServices(
    () => geometryRef.current ??= createGeometryWorkerClient(),
    () => geometryRef.current?.cancelActive(),
  ), [suppliedServices]);
  const materialRepository = useMemo(
    () => suppliedMaterialRepository ?? new MaterialRepository(),
    [suppliedMaterialRepository],
  );
  const [storedProfiles, setStoredProfiles] = useState<readonly MaterialProfileV1[]>([]);
  const [materialLoadFailed, setMaterialLoadFailed] = useState(false);
  const [chromeTarget, setChromeTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    let active = true;
    setStoredProfiles([]);
    setMaterialLoadFailed(false);
    void listMaterialCatalog(materialRepository).then((catalog) => {
      if (!active) return;
      setStoredProfiles(catalog.flatMap((entry) => (
        entry.source === 'stored' && entry.readiness.status === 'ready' ? [entry.profile] : []
      )));
    }).catch(() => {
      if (!active) return;
      setStoredProfiles([]);
      setMaterialLoadFailed(true);
    });
    return () => { active = false; };
  }, [materialRepository]);
  const oneClickServices = useMemo<OneClickConverterServices>(() => ({
    ...services,
    materialProfiles: [...(services.materialProfiles ?? []), ...storedProfiles],
  }), [services, storedProfiles]);
  useEffect(() => () => geometryRef.current?.dispose(), []);
  return (
    <div className="app-shell">
      <header className="site-header floating-chrome">
        <a className="brand" href="./" aria-label="ShapeCut 首頁"><span aria-hidden="true">S</span>ShapeCut</a>
        <p className="privacy-status">私隱優先 · 本機處理</p>
        <div className="current-step-slot" ref={setChromeTarget} />
      </header>
      <main>
        {materialLoadFailed && <p role="alert">已儲存的材料設定檔未能載入；請稍後重試。</p>}
        <OneClickConverter services={oneClickServices} chromeTarget={chromeTarget} />
      </main>
      <footer>輸出為通用外形，不包含雷射功率或速度。正式製作前請先試切。</footer>
    </div>
  );
}
