import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { AppSessionProvider, StudioGate } from "./app";
import { ROUTE_PATHS, ROUTE_TABLE } from "./routes";

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
        <Route path={ROUTE_PATHS.studio} element={<StudioGate />} />
        {ROUTE_TABLE.map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {import.meta.env.DEV && ComponentLab && (
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
