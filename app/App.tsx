// ROUTE LEDGER (collision slot): one line per screen. scripts/validators/screens-registered.mjs
// checks every file in app/pages has a route here and a help guide in help/guides.
import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { useApp } from "./state";
import { studio } from "./lib/studio";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { Dump } from "./pages/Dump";
import { Review } from "./pages/Review";
import { Calendar } from "./pages/Calendar";
import { ClientBrain } from "./pages/ClientBrain";
import { Research } from "./pages/Research";
import { Stats } from "./pages/Stats";
import { Voice } from "./pages/Voice";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Connect } from "./pages/Connect";
import { Deals } from "./pages/Deals";
import { MediaKit } from "./pages/MediaKit";
import { MediaKitPrint } from "./pages/MediaKit";
import { Help } from "./pages/Help";
import { HelpGuide } from "./pages/HelpGuide";

export function App() {
  const { me, ready, unreachable, refreshMe } = useApp();
  if (!ready) return null;
  if (!me && unreachable) return <Unreachable onRetry={refreshMe} />;
  return (
    <Routes>
      <Route path="/kit/:slug" element={<MediaKit />} />
      <Route path="/kit/:slug/print" element={<MediaKitPrint />} />
      {!me ? (
        <Route path="*" element={<Login />} />
      ) : (
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="/dump" element={<Dump />} />
          <Route path="/dump/:id" element={<Dump />} />
          <Route path="/review" element={<Review />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/brain" element={<ClientBrain />} />
          <Route path="/research" element={<Research />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/connections" element={<Connect />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/help" element={<Help />} />
          <Route path="/help/:slug" element={<HelpGuide />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}

/** /api/me failed for a reason other than "not logged in": say so and offer a retry. */
function Unreachable({ onRetry }: { onRetry: () => Promise<void> }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-title">
          <h1>{studio().appName}</h1>
        </div>
        <p className="section">We could not reach your dashboard just now. Check your connection, then try again.</p>
        <button type="button" className="btn big block" data-primary onClick={() => void onRetry()}>
          Try again
        </button>
      </div>
    </div>
  );
}
