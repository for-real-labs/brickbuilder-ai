import { NotificationMenu } from "./NotificationMenu";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { User, ChevronDown, Sparkles, Settings, LogOut } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { ChangeRequestMenuItem } from "./ChangeRequestLauncher";

interface ProfileMenuProps {
  /**
   * Optional navigation override. Pages with guarded navigation (e.g. unsaved
   * changes prompts) can pass their own handler. Defaults to react-router navigate.
   */
  onNavigate?: (path: string) => void;
}

/**
 * Reusable account dropdown shown in page headers for logged-in users.
 * Displays the user id and quick links to the dashboard's generations and
 * settings tabs, plus a log out action.
 * 
 * When Supabase is not configured, the menu shows navigation links but hides
 * the username and logout option.
 */
export function ProfileMenu({ onNavigate }: ProfileMenuProps) {
  const navigate = useNavigate();
  const { user, userProfile, signOut, isSupabaseConfigured } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);

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
    <div className="flex items-center gap-2">
    <div className="relative">
      <button
        aria-label="Account menu"
        aria-expanded={dropdownOpen}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex h-8 items-center gap-1 rounded-full border-none bg-slate-100 px-2 cursor-pointer transition-colors hover:bg-slate-200 sm:h-9 sm:gap-2 sm:px-3"
      >
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f44336] sm:h-6 sm:w-6">
          <User className="h-3.5 w-3.5 text-white sm:h-4 sm:w-4" />
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 text-slate-600 transition-transform sm:h-4 sm:w-4 ${
            dropdownOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {dropdownOpen && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0"
            style={{ zIndex: 40 }}
            onClick={() => setDropdownOpen(false)}
          />
          {/* Dropdown menu */}
          <div
            className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-200 py-2"
            style={{ zIndex: 51 }}
          >
            {/* User identity - only show when Supabase is configured and user is logged in */}
            {showUserIdentity && (
              <div className="px-4 py-2 border-b border-slate-100">
                <p className="text-sm font-semibold text-slate-900 truncate">
                  {displayName}
                </p>
              </div>
            )}

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
          </div>
        </>
      )}
    </div>
    <NotificationMenu onNavigate={onNavigate} />
    </div>
  );
}
