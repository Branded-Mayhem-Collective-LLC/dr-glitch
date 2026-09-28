import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppSessionProvider, StudioGate } from "./app";
import { ROUTE_PATHS, ROUTE_TABLE } from "./routes";
import { WORKSTATION_REVIEW } from "./workflow-mode";
import { BrowserStudioGate } from "./studio/BrowserStudioGate";

/**
 * Development-only component lab. The DEV guard is statically false in
 * production builds, so the lazy chunk is dead-code-eliminated and the
 * route never registers outside `vite dev`.
 */
const ComponentLab = import.meta.env.DEV
  ? lazy(() => import("./dev/ComponentLab"))
  : null;

export default function App() {
  return (
    <AppSessionProvider>
      <Routes>
        <Route path={ROUTE_PATHS.studio} element={WORKSTATION_REVIEW ? <StudioGate /> : <BrowserStudioGate />} />
        {ROUTE_TABLE.filter(({ path }) => WORKSTATION_REVIEW || path === "/login" || path === "/signup").map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {!WORKSTATION_REVIEW && <Route path="*" element={<Navigate to="/" replace />} />}
        {WORKSTATION_REVIEW && ComponentLab && (
          <Route
            path="/dev/lab"
            element={
              <Suspense fallback={null}>
                <ComponentLab />
              </Suspense>
            }
          />
        )}
      </Routes>
    </AppSessionProvider>
  );
}
