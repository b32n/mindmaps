import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { AuthProvider, RequireAuth, RedirectIfAuthed } from "./AuthContext";
import { HomePage } from "./pages/Home";
import { BrainPage } from "./pages/Brain";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { BoardApp } from "./App";
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
            path="/app/:boardId"
            element={
              <RequireAuth>
                <BoardApp />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
