import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readConfig } from './config';
import { createServices } from './services';
import './styles.css';

const config = readConfig(import.meta.env as unknown as Record<string, string | undefined>, location.search);
const services = createServices(config);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App config={config} services={services} />
  </StrictMode>,
);
