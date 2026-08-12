import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// Public seller routes live outside /app and need a root-based router.
const isPublicSellerPath =
  window.location.pathname.startsWith('/s/') ||
  (window.location.pathname !== '/' && !window.location.pathname.startsWith('/app') && !window.location.pathname.startsWith('/auth'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={isPublicSellerPath ? '/' : '/app'}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
