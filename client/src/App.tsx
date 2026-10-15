import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useMatch, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, cycleName, type Cycle, type Me } from "./api";
import { AccountPage } from "./pages/Account";
import { CgpaPage } from "./pages/Cgpa";
import { ChecklistPage } from "./pages/Checklist";
import { CollectPage } from "./pages/Collect";
import { ConfirmLoginPage } from "./pages/ConfirmLogin";
import { DashboardPage } from "./pages/Dashboard";
import { ExportPage } from "./pages/Export";
import { WorkbookPage } from "./pages/Workbook";
import { LoginPage } from "./pages/Login";
import { MetricPage } from "./pages/Metric";
import { NewCyclePage } from "./pages/NewCycle";
import { ProfilePage } from "./pages/Profile";
import { ReportSettingsPage } from "./pages/ReportSettings";
import { ReportsPage } from "./pages/Reports";
import { ReviewPage } from "./pages/Review";
import { SearchPage } from "./pages/Search";
import { TrendsPage } from "./pages/Trends";
import { Icon, type IconName } from "./pages/Icon";
import { ConfirmProvider, EmptyState, Loading, PageLoading } from "./pages/ui";

interface Ctx {
  me: Me;
  /** The user's private workspace; every report lives in it. */
  collegeId: string;
  role: Me["memberships"][number]["role"];
  cycles: Cycle[];
  cyclesLoaded: boolean;
  reloadCycles: () => Promise<void>;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export function App() {
  const path = useLocation().pathname;
  // A sign-in link opened in another browser: confirm before signing in, whoever is signed in now.
  if (path === "/login/confirm") return <ConfirmLoginPage />;
  // Collection links are for people without an account: no sign-in, no app chrome.
  if (path.startsWith("/collect/")) {
    return (
      <ConfirmProvider>
        <header className="publicbar">
          <Brand />
        </header>
        <Routes>
          <Route path="/collect/:token" element={<CollectPage />} />
        </Routes>
      </ConfirmProvider>
    );
  }
  return (
    <ConfirmProvider>
      <SignedInApp />
    </ConfirmProvider>
  );
}

function Brand({ to }: { to?: string }) {
  const inner = (
    <>
      <img src="/icon.svg" alt="" />
      NAAC Assistant
    </>
  );
  return to ? (
    <Link to={to} className="brand">
      {inner}
    </Link>
  ) : (
    <span className="brand">{inner}</span>
  );
}

function SignedInApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cyclesLoaded, setCyclesLoaded] = useState(false);

  useEffect(() => {
    api
      .get<Me>("/api/v1/me")
      .then(setMe)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
        setMe(null);
      });
  }, []);

  // Own workspace first (the server sorts it first); shared workspaces come later.
  const workspace = me?.memberships[0];

  const reloadCycles = useCallback(async () => {
    if (!workspace) return;
    const [own, shared] = await Promise.all([
      api.get<Omit<Cycle, "access">[]>(`/api/v1/colleges/${workspace.college_id}/cycles`),
      api.get<Cycle[]>("/api/v1/shared-reports"),
    ]);
    setCycles([...own.map((c) => ({ ...c, access: "owner" as const })), ...shared]);
    setCyclesLoaded(true);
  }, [workspace?.college_id]);

  useEffect(() => {
    void reloadCycles();
  }, [reloadCycles]);

  if (me === undefined)
    return (
      <div className="center">
        <Loading />
      </div>
    );
  if (me === null) return <LoginPage />;
  if (!workspace)
    return (
      <main className="page narrow">
        <EmptyState icon="info" title="Your workspace is being set up">
          Sign out and sign in again in a minute.
        </EmptyState>
      </main>
    );

  return (
    <AppCtx.Provider value={{ me, collegeId: workspace.college_id, role: workspace.role, cycles, cyclesLoaded, reloadCycles }}>
      <Shell>
        <Routes>
          <Route path="/" element={<ReportsPage />} />
          <Route path="/reports/new" element={<NewCyclePage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/c/:cycleId/*" element={<CycleShell />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Shell>
    </AppCtx.Provider>
  );
}

/** Sidebar with the report switcher and the report's sections; a drawer below 900px. */
function Shell({ children }: { children: React.ReactNode }) {
  const { me, cycles } = useApp();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const cycleId = useMatch("/c/:cycleId/*")?.params.cycleId;
  const cycle = cycles.find((c) => c.id === cycleId);

  // Choosing a destination closes the drawer.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  const base = cycle ? `/c/${cycle.id}` : "";
  return (
    <div className="shell">
      <aside className={open ? "sidebar open" : "sidebar"} id="sidebar" aria-label="Main">
        <div className="sidebar-head">
          <Brand to="/" />
        </div>
        {cycle && (
          <div className="report-switch">
            <select value={cycle.id} onChange={(e) => nav(`/c/${e.target.value}`)} aria-label="Report">
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.college_name} · {cycleName(c)}
                </option>
              ))}
            </select>
            {cycle.access !== "owner" && (
              <div className="access">
                <Icon name={cycle.access === "editor" ? "users" : "eye"} size={13} />
                <span className="truncate">
                  Shared by {cycle.owner_email ?? "another user"} · {cycle.access === "editor" ? "you can edit" : "view only"}
                </span>
              </div>
            )}
          </div>
        )}
        <nav>
          <NavItem to="/" icon="reports" end>
            My reports
          </NavItem>
          {cycle && (
            <>
              <div className="nav-label">Prepare</div>
              <NavItem to={base} icon="dashboard" end>
                Dashboard
              </NavItem>
              <NavItem to={`${base}/profile`} icon="profile">
                Extended profile
              </NavItem>
              <NavItem to={`${base}/workbook`} icon="workbook">
                Data workbook
              </NavItem>
              {cycle.access !== "viewer" && <ReviewLink cycleId={cycle.id} />}
              <div className="nav-label">Check</div>
              <NavItem to={`${base}/checklist`} icon="checklist">
                Review checklist
              </NavItem>
              <NavItem to={`${base}/cgpa`} icon="gauge">
                Estimated CGPA
              </NavItem>
              <NavItem to={`${base}/trends`} icon="trends">
                Trends
              </NavItem>
              <NavItem to={`${base}/search`} icon="search">
                Search NAAC
              </NavItem>
              <div className="nav-label">Finish</div>
              <NavItem to={`${base}/export`} icon="download">
                Export
              </NavItem>
              {cycle.access === "owner" && (
                <NavItem to={`${base}/settings`} icon="settings">
                  Report settings
                </NavItem>
              )}
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <Link to="/account" className="email truncate" title={`${me.user.email}: account, members and sessions`}>
            {me.user.email}
          </Link>
          <Link to="/account" className="btn ghost icon sm" title="Account" aria-label="Account">
            <Icon name="settings" />
          </Link>
          <button
            className="btn ghost icon sm"
            title="Sign out"
            aria-label="Sign out"
            onClick={async () => {
              await api.post("/api/v1/auth/logout");
              location.href = "/";
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className={open ? "scrim open" : "scrim"} onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="main">
        <header className="mobilebar">
          <button className="btn ghost icon" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(true)}>
            <Icon name="menu" size={18} />
          </button>
          <Brand to="/" />
          {cycle && <span className="title truncate">· {cycleName(cycle)}</span>}
        </header>
        {children}
      </div>
    </div>
  );
}

function NavItem({ to, icon, end, children }: { to: string; icon: IconName; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
      <Icon name={icon} />
      {children}
    </NavLink>
  );
}

function CycleShell() {
  const { cycleId } = useParams();
  const { cycles, cyclesLoaded } = useApp();
  const cycle = cycles.find((c) => c.id === cycleId);
  if (!cyclesLoaded) return <PageLoading />;
  if (!cycle) return <Navigate to="/" />;
  return (
    <>
      <Routes>
        <Route index element={<DashboardPage cycle={cycle} />} />
        <Route path="profile" element={<ProfilePage cycle={cycle} />} />
        <Route path="checklist" element={<ChecklistPage cycle={cycle} />} />
        <Route path="search" element={<SearchPage cycle={cycle} />} />
        <Route path="settings" element={cycle.access === "owner" ? <ReportSettingsPage cycle={cycle} /> : <Navigate to={`/c/${cycle.id}`} />} />
        <Route path="export" element={<ExportPage cycle={cycle} />} />
        <Route path="workbook" element={<WorkbookPage cycle={cycle} />} />
        <Route path="review" element={<ReviewPage cycle={cycle} />} />
        <Route path="cgpa" element={<CgpaPage cycle={cycle} />} />
        <Route path="trends" element={<TrendsPage cycle={cycle} />} />
        <Route path="m/:metricId" element={<MetricPage cycle={cycle} />} />
      </Routes>
    </>
  );
}

/** Menu link with the number of submissions waiting, refreshed when the page changes. */
function ReviewLink({ cycleId }: { cycleId: string }) {
  const [pending, setPending] = useState(0);
  const { pathname } = useLocation();
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    window.addEventListener("submissions-changed", bump);
    return () => window.removeEventListener("submissions-changed", bump);
  }, []);
  useEffect(() => {
    api.get<unknown[]>(`/api/v1/cycles/${cycleId}/submissions?status=pending`).then((s) => setPending(s.length), () => setPending(0));
  }, [cycleId, pathname, n]);
  return (
    <NavLink to={`/c/${cycleId}/review`} className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
      <Icon name="inbox" />
      Review submissions
      {pending > 0 && (
        <span className="nav-count" aria-label={`${pending} waiting`}>
          {pending}
        </span>
      )}
    </NavLink>
  );
}
