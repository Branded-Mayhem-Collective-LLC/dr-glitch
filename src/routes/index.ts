/**
 * Route components and the suggested route table.
 *
 * App.tsx is owned by the workspace-shell agent. It should render the
 * entries below with react-router <Routes>/<Route>. The studio route ("/")
 * stays whatever component the shell agent ships; ROUTE_PATHS.studio
 * records the path this module's navigation (Home's onOpenProject) expects.
 */

import type { ComponentType } from "react";
import Home, { setProjectLibrary } from "./Home";
import Landing from "./Landing";
import Login from "./Login";
import Signup from "./Signup";

export { Home, Landing, Login, Signup, setProjectLibrary };

export const ROUTE_PATHS = {
  /** Workspace/studio shell — component owned by the shell agent. */
  studio: "/",
  home: "/home",
  landing: "/landing",
  login: "/login",
  signup: "/signup",
} as const;

export type RouteEntry = {
  path: string;
  Component: ComponentType;
};

/**
 * Suggested wiring for App.tsx (excludes the studio route, whose component
 * the shell agent owns):
 *
 *   <Routes>
 *     <Route path={ROUTE_PATHS.studio} element={<WorkspaceShell />} />
 *     {ROUTE_TABLE.map(({ path, Component }) => (
 *       <Route key={path} path={path} element={<Component />} />
 *     ))}
 *   </Routes>
 */
export const ROUTE_TABLE: RouteEntry[] = [
  { path: ROUTE_PATHS.home, Component: Home },
  { path: ROUTE_PATHS.landing, Component: Landing },
  { path: ROUTE_PATHS.login, Component: Login },
  { path: ROUTE_PATHS.signup, Component: Signup },
];
