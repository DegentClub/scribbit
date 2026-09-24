import type { AppConfig } from '../config';

export const txUrl = (app: AppConfig, txid: string) => `${app.explorerUrl}/tx/${txid}`;
export const ordinalsInscriptionUrl = (app: AppConfig, id: string) => `${app.ordUrl}/inscription/${id}`;
export const ordinalsContentUrl = (app: AppConfig, id: string) => `${app.ordUrl}/content/${id}`;
export const blockspaceInscriptionUrl = (app: AppConfig, id: string) => `https://explore.block.space/inscription/${id}`;
export const countersGalleryUrl = (app: AppConfig, asset: string) => `${app.countersGalleryUrl}/asset/${encodeURIComponent(asset)}`;
export const countersFunUrl = (app: AppConfig, asset: string) => `${app.countersFunUrl}/c/${encodeURIComponent(asset)}`;
export const slipstreamUrl = (app: AppConfig) => app.slipstreamUrl;
