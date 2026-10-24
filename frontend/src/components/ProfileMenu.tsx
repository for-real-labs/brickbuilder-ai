import { CreditBalance } from './BillingComponents';
import { NotificationPanel } from "./NotificationMenu";
import React, { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, User, ChevronDown, ChevronRight, CreditCard, Sparkles, Settings, LogOut } from "lucide-react";
import posthog from "posthog-js";
import { useAuth } from "../contexts/AuthContext";
import { useGenerationNotifications } from "../contexts/GenerationNotificationsContext";
import { ChangeRequestMenuItem } from "./ChangeRequestLauncher";

interface ProfileMenuProps {
  showCredits?: boolean;
  /**
   * Optional navigation override. Pages with guarded navigation (e.g. unsaved
   * changes prompts) can pass their own handler. Defaults to react-router navigate.
   */
  onNavigate?: (path: string) => void;
}

/**
 * Reusable account dropdown shown in page headers for logged-in users.
 * Displays the user id and quick links to the dashboard's generations and
 * settings tabs, a notifications submenu, and a log out action.
 * 
 * When Supabase is not configured, the menu shows navigation links but hides
 * the username and logout option.
 */
export function ProfileMenu({ onNavigate, showCredits = true }: ProfileMenuProps) {
  const navigate = useNavigate();
  const { user, userProfile, signOut, isSupabaseConfigured } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [view, setView] = useState<"profile" | "notifications">("profile");
  const feed = useGenerationNotifications();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const notificationsButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const unreadId = useId();

  useEffect(() => {
    if (!dropdownOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setDropdownOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDropdownOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [dropdownOpen]);

  useEffect(() => {
    if (dropdownOpen && view === "profile") notificationsButton.current?.focus();
  }, [view, dropdownOpen]);

  const go = (path: string) => {
    setDropdownOpen(false);
    if (onNavigate) {
      onNavigate(path);
    } else {
      navigate(path);
    }
  };

  const displayName =
    (userProfile?.username && userProfile.username.trim()) ||
    user?.email ||
    "Account";

  // Only show username when Supabase is configured and user is logged in
  const showUserIdentity = isSupabaseConfigured && user;

  return (
    <div className="flex items-center gap-2">{showCredits && <CreditBalance />}<div ref={container} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label="Profile"
        title="Profile"
        aria-expanded={dropdownOpen}
        aria-controls={panelId}
        aria-describedby={feed.unread_count > 0 ? unreadId : undefined}
        onClick={() => { setView("profile"); setDropdownOpen(!dropdownOpen); }}
        className="relative inline-flex h-9 w-9 cursor-pointer items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/90 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2 sm:w-auto sm:px-3"
      >
        <User aria-hidden="true" className="h-4 w-4" />
        <span className="hidden sm:inline">Profile</span>
        <ChevronDown
          aria-hidden="true"
          className={`hidden h-3.5 w-3.5 transition-transform sm:block ${
            dropdownOpen ? "rotate-180" : ""
          }`}
        />
        {feed.unread_count > 0 && <>
          <span aria-hidden="true" data-testid="profile-notification-indicator" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[#f44336] ring-2 ring-white" />
          <span id={unreadId} className="sr-only">{feed.unread_count} unread notifications</span>
        </>}
      </button>

      {dropdownOpen && (
        <>
          {/* Dropdown menu */}
          <div
            id={panelId}
            className={`absolute right-0 mt-2 max-h-[calc(100dvh-6rem)] max-w-[calc(100vw-2rem)] overflow-y-auto bg-white rounded-xl shadow-lg border border-slate-200 ${view === "notifications" ? "w-[22rem]" : "w-56 py-2"}`}
            style={{ zIndex: 51 }}
          >
            {view === "notifications" ? <section aria-label="Model notifications">
              <NotificationPanel onNavigate={go} onBack={() => {
                posthog.capture("generation_notifications_back_clicked", { source: "profile_menu" });
                setView("profile");
              }} />
            </section> : <>
              {/* User identity - only show when Supabase is configured and user is logged in */}
              {showUserIdentity && (
                <div className="px-4 py-2 border-b border-slate-100">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {displayName}
                  </p>
                </div>
              )}

              <button
                ref={notificationsButton}
                type="button"
                aria-label={`Notifications${feed.unread_count ? `, ${feed.unread_count} unread` : ""}`}
                onClick={() => {
                  setView("notifications");
                  feed.refresh();
                  posthog.capture("generation_notifications_opened", { unread_count: feed.unread_count, source: "profile_menu" });
                }}
                className="w-full min-h-11 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 cursor-pointer bg-transparent border-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-400"
              >
                <Bell aria-hidden="true" className="h-4 w-4" />
                <span className="flex-1">Notifications</span>
                {feed.unread_count > 0 && <span aria-hidden="true" className="rounded-full bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-600">{feed.unread_count > 99 ? "99+" : feed.unread_count}</span>}
                <ChevronRight aria-hidden="true" className="h-4 w-4 text-slate-400" />
              </button>

              <button
                onClick={() => go("/dashboard?tab=generations")}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 cursor-pointer bg-transparent border-none"
              >
                <Sparkles className="h-4 w-4" />
                My Generations
              </button>

              <button
                onClick={() => go("/dashboard?tab=settings")}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 cursor-pointer bg-transparent border-none"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>

              <button onClick={() => { posthog.capture('billing_navigation_clicked', { source: 'profile_menu' }); go('/billing'); }}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 cursor-pointer bg-transparent border-none">
                <CreditCard aria-hidden="true" className="h-4 w-4" />Manage Plan
              </button>
              <ChangeRequestMenuItem onSelect={() => setDropdownOpen(false)} />

              {/* Logout - only show when Supabase is configured */}
              {isSupabaseConfigured && (
                <>
                  <div className="my-1 border-t border-slate-100" />

                  <button
                    onClick={async () => {
                      setDropdownOpen(false);
                      await signOut();
                      navigate("/");
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 cursor-pointer bg-transparent border-none"
                  >
                    <LogOut className="h-4 w-4" />
                    Log out
                  </button>
                </>
              )}
            </>}
          </div>
        </>
      )}
    </div></div>
  );
}
