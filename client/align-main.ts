import { startAlignMode } from './align-mode';

const mapName = new URLSearchParams(location.search).get('map') ?? 'silver_lake';
void startAlignMode(mapName);
