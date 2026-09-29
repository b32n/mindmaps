import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { AuthProvider, RequireAuth, RedirectIfAuthed } from "./AuthContext";
import { HomePage } from "./pages/Home";
import { BrainPage } from "./pages/Brain";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { BoardApp } from "./App";

/**
 * The three artefact engines, each loaded on demand.
 *
 * Behind `lazy` so a board that holds no sheets never downloads the spreadsheet
 * engine, and one with no decks never downloads the presentation engine. This
 * is the whole reason artefacts open on a route rather than expanding inside a
 * card — together they are several megabytes nobody should pay for up front.
 */
const SheetEditor = lazy(() => import("./pages/SheetEditor"));
const DocEditor = lazy(() => import("./pages/DocEditor"));
const DeckEditor = lazy(() => import("./pages/DeckEditor"));
const PageEditor = lazy(() => import("./pages/PageEditor"));
const FileView = lazy(() => import("./pages/FileView"));

/**
 * The share viewer. Public by design — it is the one route that must work for
 * someone with no account, so it sits outside RequireAuth.
 */
const SharedView = lazy(() => import("./pages/SharedView"));
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* Public, and public on purpose: it is the page that explains what
              the thing is, so it has to be readable before you sign up. */}
          <Route path="/brain" element={<BrainPage />} />
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <LoginPage />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/register"
            element={
              <RedirectIfAuthed>
                <RegisterPage />
              </RedirectIfAuthed>
            }
          />
          {/* A mindmap is a place, so it gets an address. `/app` on its own
              still works and lands you on the first one — old links, and the
              sign-in redirect, both go through it. */}
          <Route
            path="/app"
            element={
              <RequireAuth>
                <BoardApp />
              </RequireAuth>
            }
          />
          <Route
            path="/sheet/:nodeId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="sheet-page" />}>
                  <SheetEditor />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/doc/:nodeId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="sheet-page" />}>
                  <DocEditor />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/page/:nodeId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="sheet-page" />}>
                  <PageEditor />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/deck/:nodeId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="sheet-page" />}>
                  <DeckEditor />
                </Suspense>
              </RequireAuth>
            }
          />
          {/* Both `file` and `folder` nodes land here: one list, one upload
              path. Lazy like the editors, though this chunk is small — it has
              no engine behind it, only a list and a form. */}
          <Route
            path="/file/:nodeId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="sheet-page" />}>
                  <FileView />
                </Suspense>
              </RequireAuth>
            }
          />
          {/* A sibling of the mindmaps rather than one of them, so it sits
              beside /app rather than under it — /app/:boardId would swallow it
              as a board id. */}
          <Route
            path="/artefacts"
            element={
              <RequireAuth>
                <BoardApp />
              </RequireAuth>
            }
          />
          <Route
            path="/app/:boardId"
            element={
              <RequireAuth>
                <BoardApp />
              </RequireAuth>
            }
          />
          <Route
            path="/v/:token"
            element={
              <Suspense fallback={<div className="shared-page" />}>
                <SharedView />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
