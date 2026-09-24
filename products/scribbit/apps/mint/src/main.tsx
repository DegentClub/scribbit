import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readConfig } from './config';
import { createServices } from './services';
import './styles.css';

const app = readConfig(import.meta.env as unknown as Record<string, string | undefined>, location.search);
const services = createServices(app);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App app={app} services={services} />
  </StrictMode>,
);
