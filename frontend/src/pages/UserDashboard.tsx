import { NotificationMenu } from "../components/NotificationMenu";

import React, { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Package, Box, User as UserIcon, ChevronRight,
  Clock, Calendar, Coins, Truck, ExternalLink, CheckCircle2,
  Sparkles, TrendingUp, LogOut, Eye, Menu, X, ChevronDown, ChevronUp, History,
  Settings as SettingsIcon, Loader2, Pencil, Users
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { GetUserGenerationsApiService, GenerationWithOrder, OrderInfo } from "../services/getUserGenerationsApi";
import { GetGenerationsByImageApiService, GenerationIteration } from "../services/getGenerationsByImageApi";
import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";
import { isGenerationActive } from "../hooks/useGenerationActivity";
import { getGeneratedModelPath } from "../utils/generationRoutes";
import posthog from "posthog-js";

type TabKey = "dashboard" | "generations" | "orders" | "settings";

// Mirrors the backend /updateUsername validation: 3-30 chars,
// letters, numbers, underscores, hyphens, or periods.
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;

/* ----------------------------- Sidebar ----------------------------- */
const Sidebar: React.FC<{active:TabKey; onChange:(t:TabKey)=>void; onLogout:()=>void; isOpen:boolean; onClose:()=>void; showLogout:boolean}> = ({active, onChange, onLogout, isOpen, onClose, showLogout}) => {
  const tabs: { key: TabKey; label: string; icon: any }[] = [
    { key: "dashboard", label: "Overview", icon: TrendingUp },
    { key: "generations", label: "My Generations", icon: Sparkles },
    { key: "orders",    label: "My Orders",      icon: Package },
    { key: "settings",  label: "Settings",       icon: SettingsIcon },
  ];

  const handleTabChange = (t: TabKey) => {
    onChange(t);
    onClose(); // Close sidebar on mobile after selection
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}
      
      <aside className={`fixed lg:sticky top-0 h-screen w-72 border-r border-slate-200 bg-white flex flex-col z-50 transition-transform duration-300 lg:translate-x-0 ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
        <Link to="/" className="text-2xl font-extrabold tracking-tight block">
          <span className="text-[#f44336]">BRICK</span>
          <span className="text-slate-900">BUILDER</span>
        </Link>
        <button
          onClick={onClose}
          className="lg:hidden p-2 hover:bg-slate-100 rounded-lg"
          aria-label="Close menu"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Nav (scrolls), reserve space for fixed bottom */}
      <nav className={`p-4 space-y-3 flex-1 overflow-y-auto ${showLogout ? 'pb-40' : 'pb-4'}`}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;

          return (
            <button
              key={t.key}
              onClick={() => handleTabChange(t.key)}
              className={`w-full flex items-center gap-3 px-5 py-3 mb-2.5 rounded-xl border-2 text-sm font-medium cursor-pointer transition-all duration-200 ${
                isActive 
                  ? "border-[#f44336] bg-red-50 text-[#f44336] hover:bg-red-100" 
                  : "border-transparent bg-transparent text-slate-700 hover:bg-slate-50 hover:border-[#f44336]"
              }`}
            >
              <Icon style={{ width: "18px", height: "18px" }} />
              <span style={{ flex: 1, textAlign: "left" }}>{t.label}</span>
              {isActive && (
                <ChevronRight
                  style={{ width: "18px", height: "18px", marginLeft: "auto" }}
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Logout — pinned bottom of sidebar (only when Supabase is configured) */}
      {showLogout && (
        <div className="absolute left-0 bottom-0 w-full p-4 border-t border-slate-200 bg-white">
          <button 
            onClick={onLogout}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </div>
      )}
    </aside>
    </>
  );
};

/* ----------------------------- Bits ----------------------------- */
const StatsCard: React.FC<{icon:any; label:string; value:string|number; onClick?:()=>void}> = ({icon:Icon, label, value, onClick}) => (
  <div 
    onClick={onClick}
    className="rounded-2xl border border-slate-200 p-4 sm:p-6 bg-white flex items-center gap-3 sm:gap-4 transition-colors hover:bg-slate-50 cursor-pointer"
  >
    <div
      className="inline-flex items-center justify-center rounded-full flex-shrink-0"
      style={{
        width: 48,
        height: 48,
        backgroundColor: "#f44336",
        borderRadius: "9999px",
      }}
    >
      <Icon style={{ width: 20, height: 20, color: "#ffffff" }} />
    </div>
    <div className="min-w-0">
      <div className="text-xs sm:text-sm text-slate-500 truncate">{label}</div>
      <div className="font-semibold text-xl sm:text-2xl text-slate-900">{value}</div>
    </div>
  </div>
);

// Simple card that just displays an image
export const GenerationCard: React.FC<{g: GenerationWithOrder; onView: (generationId: string, exact: boolean) => void; authToken?: string}> = ({g, onView, authToken}) => {
  const navigate = useNavigate();
  const [showEdits, setShowEdits] = useState(false);
  const [edits, setEdits] = useState<GenerationIteration[]>([]);
  const [loadingEdits, setLoadingEdits] = useState(false);
  const [editsError, setEditsError] = useState<string | null>(null);
  
  // Truncate prompt for display
  const displayPrompt = g.prompt.length > 60 ? g.prompt.slice(0, 60) + "..." : g.prompt;
  
  // Debug: log what image fields are available
  console.log('Generation image fields:', { 
    id: g.id, 
    external_image_url: g.external_image_url, 
    image_url: g.image_url, 
    thumbnail_url: g.thumbnail_url,
    preview_image_url: g.preview_image_url,
  });
  
  const isProcessing = isGenerationActive(g.status);
  const completedGenerationId = isProcessing ? g.previous_completed_generation_id : null;
  const canView = (!isProcessing && g.status !== 'failed') || Boolean(completedGenerationId);
  const previewImage = completedGenerationId ? g.previous_completed_preview_image_url : g.preview_image_url;
  const handleView = () => {
    const viewedGenerationId = completedGenerationId || g.id;
    posthog.capture('dashboard_generation_viewed', {
      generation_id: g.id, viewed_generation_id: viewedGenerationId, status: g.status,
    });
    onView(viewedGenerationId, Boolean(completedGenerationId));
  };

  // Source image (the user-provided/original image), matches community page logic
  const sourceImage = g.external_image_url || g.image_url || g.thumbnail_url || g.processed_image_url;
  // Main image is the rendered preview when available, falling back to the source
  const mainImage = previewImage || sourceImage;
  const showOverlay = Boolean(previewImage && sourceImage);
  
  const handleViewEdits = async () => {
    if (!showEdits && edits.length === 0 && g.id) {
      setLoadingEdits(true);
      setEditsError(null);
      
      try {
        const response = await GetGenerationsByImageApiService.getGenerationsByImage(
          authToken,
          g.id
        );
        // Sort by saved version rather than image or timestamp
        const sortedEdits = response.generations.sort((a, b) => {
          return b.version - a.version;
        });
        setEdits(sortedEdits);
      } catch (error) {
        console.error('Error fetching edits:', error);
        setEditsError('Failed to load edit history');
      } finally {
        setLoadingEdits(false);
      }
    }
    setShowEdits(!showEdits);
  };
  
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow transition-shadow">
      <div className="p-3 sm:p-4 flex gap-3 sm:gap-4">
        <button
          type="button"
          onClick={handleView}
          disabled={!canView}
          aria-label="View model preview"
          className={`relative w-20 h-20 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-slate-100 border flex-shrink-0 ${canView ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {mainImage ? (
            <img
              src={mainImage}
              alt={g.prompt}
              className="absolute inset-0 w-full h-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-slate-300" />
            </div>
          )}
          {showOverlay && (
            <div className="absolute top-1 right-1 w-1/3 aspect-square rounded-md overflow-hidden border-2 border-white shadow-md bg-slate-100">
              <img
                src={sourceImage as string}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
                onError={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.display = "none";
                }}
              />
            </div>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm sm:text-base text-slate-900 leading-tight line-clamp-2">{displayPrompt}</h3>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[11px] sm:text-xs text-slate-600 mt-1">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 sm:w-3.5 sm:h-3.5"/>
                  {new Date(g.created_at).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"})}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5"/>
                  {new Date(g.created_at).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"})}
                </span>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-[10px] sm:text-[11px] text-slate-500">ID</div>
              <div className="font-mono text-[11px] sm:text-xs text-slate-600">{g.id.slice(0, 8)}...</div>
            </div>
          </div>

          <div className="mt-2 sm:mt-3 flex gap-2 flex-wrap">
            {isProcessing ? (
              <span
                role="status"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 h-9 text-xs text-slate-500"
              >
                <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
                Processing...
              </span>
            ) : g.status === 'failed' ? (
              <div className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 h-9 text-xs text-red-600">
                <span>Generation failed</span>
              </div>
            ) : null}
            {canView && (
              <>
                <button 
                  onClick={handleView}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs hover:bg-slate-50 cursor-pointer"
                >
                  <Eye className="w-4 h-4"/> View Model
                </button>
                <button 
                  onClick={handleViewEdits}
                  disabled={!g.id}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 h-9 text-xs ${
                    g.id
                      ? 'border-slate-300 bg-white hover:bg-slate-50 cursor-pointer' 
                      : 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                  }`}
                  title={!g.id ? 'No edit history available' : 'View edit history'}
                >
                  <History className="w-4 h-4"/> 
                  View Edits
                  {g.id && (showEdits ? <ChevronUp className="w-3 h-3"/> : <ChevronDown className="w-3 h-3"/>)}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      
      {/* Expandable edits section */}
      {showEdits && (
        <div className="border-t border-slate-200 bg-slate-50 p-3 sm:p-4">
          <h4 className="text-sm font-semibold text-slate-900 mb-3">Edit History ({edits.length})</h4>
          
          {loadingEdits ? (
            <div className="flex items-center justify-center py-4 text-xs text-slate-500">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin mr-2" />
              Loading edit history...
            </div>
          ) : editsError ? (
            <div className="text-xs text-red-600 py-2">{editsError}</div>
          ) : edits.length === 0 ? (
            <div className="text-xs text-slate-500 py-2">No edit history available for this model.</div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {edits.map((edit) => {
                const isCurrentGeneration = edit.id === g.id;
                return (
                  <div 
                    key={edit.id} 
                    className={`rounded-lg border p-3 bg-white ${
                      isCurrentGeneration ? 'border-[#f44336] bg-red-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-medium text-slate-500">
                            VERSION {edit.version}
                          </span>
                          {isCurrentGeneration && (
                            <span className="text-[10px] font-medium text-[#f44336] bg-red-100 px-2 py-0.5 rounded">
                              CURRENT
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-900 font-mono mb-1.5">{edit.id}</p>
                        <div className="flex items-center gap-2 text-[10px] text-slate-500">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3"/>
                            {new Date(edit.created_at).toLocaleDateString("en-US", {month: "short", day: "numeric"})}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3"/>
                            {new Date(edit.created_at).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"})}
                          </span>
                        </div>
                      </div>
                      {edit.status === 'completed' ? (
                        <button 
                          onClick={() => navigate(`/generated-model?id=${encodeURIComponent(edit.id)}&exact=1`)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] hover:bg-slate-50 cursor-pointer flex-shrink-0"
                        >
                          <Eye className="w-3.5 h-3.5"/> View Model
                        </button>
                      ) : (
                        <span className={`inline-flex items-center px-2 py-1 rounded text-[10px] font-medium flex-shrink-0 ${
                          edit.status === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {edit.status}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Order card component
const OrderCard: React.FC<{g: GenerationWithOrder; onView: () => void}> = ({g, onView}) => {
  const order = g.order;
  if (!order) return null;
  
  // Use order fields directly, fall back to generation fields
  const displayPrompt = (order.prompt || g.prompt || 'Untitled Model').length > 50 
    ? (order.prompt || g.prompt || 'Untitled Model').slice(0, 50) + "..." 
    : (order.prompt || g.prompt || 'Untitled Model');
  const previewImage = order.image_url || g.external_image_url || g.image_url || g.thumbnail_url;
  const amountPaid = order.amount_paid ? `$${parseFloat(order.amount_paid).toFixed(2)}` : 'N/A';
  
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow transition-shadow">
      <div className="p-3 sm:p-4 flex gap-3 sm:gap-4">
        <div className="relative w-20 h-20 sm:w-28 sm:h-28 rounded-lg overflow-hidden bg-slate-100 border flex-shrink-0">
          {previewImage ? (
            <img
              src={previewImage}
              alt={displayPrompt}
              className="absolute inset-0 w-full h-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Box className="w-6 h-6 sm:w-8 sm:h-8 text-slate-300" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-sm sm:text-base text-slate-900 leading-tight line-clamp-2">{displayPrompt}</h3>
              <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs text-slate-600 mt-1">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 sm:w-3.5 sm:h-3.5"/>
                  {new Date(order.created_at || g.created_at).toLocaleDateString("en-US", {month: "short", day: "numeric"})}
                </span>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-[10px] sm:text-[11px] text-slate-500">Order ID</div>
              <div className="font-medium text-xs sm:text-sm">#{order.id}</div>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              order.fulfilled 
                ? "bg-green-100 text-green-700" 
                : "bg-yellow-100 text-yellow-700"
            }`}>
              {order.fulfilled ? (
                <><CheckCircle2 className="w-3.5 h-3.5"/> Fulfilled</>
              ) : (
                <><Truck className="w-3.5 h-3.5"/> Processing</>
              )}
            </span>
          </div>

          <div className="mt-3 flex gap-2 flex-wrap">
            <button 
              onClick={onView}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs hover:bg-slate-50 cursor-pointer"
            >
              <Eye className="w-4 h-4"/> View Model
            </button>
            <Link 
              to={`/instructions?id=${g.id}`}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs hover:bg-slate-50"
            >
              <ExternalLink className="w-4 h-4"/> View Instructions
            </Link>
            {order.brickowl_cart_url && (
              <a 
                href={order.brickowl_cart_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs hover:bg-slate-50"
              >
                <ExternalLink className="w-4 h-4"/> BrickOwl Cart
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 rounded-b-xl flex items-center justify-between text-sm">
        <span className="text-slate-600 text-xs">Total paid</span>
        <span className="font-bold text-slate-900">{amountPaid}</span>
      </div>
    </div>
  );
};

/* ----------------------------- Settings ----------------------------- */
const SettingsPanel: React.FC = () => {
  const { user, userProfile, updateUsername } = useAuth();

  const fallbackUsername = user?.email?.split('@')[0] || 'builder';
  const currentUsername = userProfile?.username?.trim() || fallbackUsername;

  const [isEditing, setIsEditing] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleStartEdit = () => {
    setUsernameInput(userProfile?.username?.trim() || currentUsername);
    setError(null);
    setSuccessMessage(null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    if (saving) return;
    setIsEditing(false);
    setUsernameInput("");
    setError(null);
  };

  const handleSave = async () => {
    if (saving) return;
    const trimmed = usernameInput.trim();
    if (!trimmed) {
      setError('Username cannot be empty.');
      return;
    }
    if (trimmed.length < 3 || trimmed.length > 30) {
      setError('Username must be 3-30 characters.');
      return;
    }
    if (!USERNAME_PATTERN.test(trimmed)) {
      setError('Username can only contain letters, numbers, underscores, hyphens, or periods.');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const { error: apiError, success } = await updateUsername(trimmed);
      if (!success) {
        setError(typeof apiError === 'string' ? apiError : 'Failed to update username.');
        return;
      }
      setIsEditing(false);
      setUsernameInput("");
      setSuccessMessage('Username updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update username.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3 sm:mb-4">Settings</h1>

      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-slate-900 mb-1">Profile</h2>
        <p className="text-sm text-slate-500 mb-5">
          Your username is shown publicly on community posts.
        </p>

        {/* Email (read-only) */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
          <div className="px-3 py-2 text-sm rounded-lg bg-slate-50 border border-slate-200 text-slate-600">
            {user?.email || '—'}
          </div>
        </div>

        {/* Username */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
          {!isEditing ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 px-3 py-2 text-sm rounded-lg bg-slate-50 border border-slate-200 text-slate-800">
                {currentUsername}
                {!userProfile?.username?.trim() && (
                  <span className="ml-2 text-xs text-slate-400">(default)</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleStartEdit}
                disabled={!userProfile}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[#f44336] hover:text-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Pencil className="w-4 h-4" />
                Edit
              </button>
            </div>
          ) : (
            <div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  value={usernameInput}
                  onChange={(e) => {
                    setUsernameInput(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSave();
                    } else if (e.key === 'Escape' && !saving) {
                      handleCancel();
                    }
                  }}
                  placeholder="Enter a username"
                  maxLength={30}
                  disabled={saving}
                  className="flex-1 px-3 py-2 text-sm rounded-lg border-2 border-slate-200 focus:border-[#f44336] focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !usernameInput.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={saving}
                    className="px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                3-30 characters. Letters, numbers, underscores, hyphens, or periods.
              </p>
              {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
            </div>
          )}
          {!isEditing && successMessage && (
            <p className="mt-2 text-sm text-green-600">{successMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
};

/* ----------------------------- Page ----------------------------- */
const UserDashboard: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const isValidTab = (t: string | null): t is TabKey =>
    t === "dashboard" || t === "generations" || t === "orders" || t === "settings";
  const [tab, setTab] = useState<TabKey>(isValidTab(tabParam) ? tabParam : "dashboard");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user, userProfile, loading, signOut, session, isSupabaseConfigured } = useAuth();
  const navigate = useNavigate();
  const [generations, setGenerations] = useState<GenerationWithOrder[]>([]);
  const [allOrders, setAllOrders] = useState<OrderInfo[]>([]);
  const [totalUserGenerations, setTotalUserGenerations] = useState(0);
  const [loadingGenerations, setLoadingGenerations] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_LIMIT = 50;

  // Keep the active tab in sync with the URL (?tab=...), e.g. when navigating
  // here from the profile menu while already on the dashboard.
  useEffect(() => {
    if (isValidTab(tabParam) && tabParam !== tab) {
      setTab(tabParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  const handleTabChange = (t: TabKey) => {
    setTab(t);
    setSearchParams(t === "dashboard" ? {} : { tab: t });
  };

  // Fetch generations for the logged-in user using the API
  const fetchGenerations = async (currentOffset: number, append: boolean = false) => {
    // When Supabase is configured, require auth token
    // When Supabase is not configured, allow anonymous access
    if (isSupabaseConfigured && !session?.access_token) return;
    
    if (append) {
      setLoadingMore(true);
    } else {
      setLoadingGenerations(true);
    }
    
    try {
      const response = await GetUserGenerationsApiService.getUserGenerations(
        session?.access_token, // Will be undefined when Supabase is not configured
        PAGE_LIMIT,
        currentOffset
      );
      
      // Sort generations by created_at in descending order (most recent first)
      const sortedGenerations = (response.generations || []).sort((a, b) => {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      
      if (append) {
        setGenerations(prev => [...prev, ...sortedGenerations]);
      } else {
        setGenerations(sortedGenerations);
      }
      setAllOrders(prev => append ? [...prev, ...(response.all_orders || [])] : (response.all_orders || []));
      setTotalUserGenerations(response.total_user_generations ?? 0);
      setHasMore(response.has_more);
    } catch (err) {
      console.error('Error fetching generations:', err);
    } finally {
      setLoadingGenerations(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    // Fetch generations when:
    // - Supabase is configured and we have a session, OR
    // - Supabase is not configured (anonymous mode)
    if (!isSupabaseConfigured || session) {
      fetchGenerations(0);
    }
  }, [session, isSupabaseConfigured]);

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_LIMIT;
    setOffset(newOffset);
    fetchGenerations(newOffset, true);
  };

  // Map all_orders to generations with order info
  const orders: GenerationWithOrder[] = allOrders.map(order => {
    // Find the matching generation
    const matchingGeneration = generations.find(g => g.id === order.generation_id);
    
    if (matchingGeneration) {
      // Return the generation with its order
      return { ...matchingGeneration, order };
    } else {
      // If no matching generation found, create a minimal generation object
      return {
        id: order.generation_id,
        user_id: '',
        user_type: '',
        prompt: 'Order #' + order.id,
        detail_level: 0,
        endpoint: '',
        created_at: order.created_at || '',
        status: 'completed',
        order
      } as GenerationWithOrder;
    }
  });

  // Redirect to signup if not authenticated (only when Supabase is configured)
  useEffect(() => {
    if (isSupabaseConfigured && !loading && !user) {
      navigate("/signup?message=dashboard");
    }
  }, [user, loading, navigate, isSupabaseConfigured]);

  const handleViewGeneration = (generationId: string, exact = false) => {
    // Navigate to view with generation ID in URL
    navigate(getGeneratedModelPath(generationId, exact));
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  // Show loading state while checking auth (only when Supabase is configured)
  if (isSupabaseConfigured && (loading || !user)) {
    return (
      <div className="min-h-screen bg-[#fbfbfd] flex items-center justify-center">
        <div className="text-slate-500">Loading...</div>
      </div>
    );
  }

  const stats = {
    total: totalUserGenerations,
    orders: orders.length,
    credits: userProfile?.credits || 0,
  };

  const displayName = user?.email?.split('@')[0] || 'Builder';

  return (
    <div className="min-h-screen bg-[#fbfbfd]">
      <SEO title="Dashboard — BrickBuilder" description="View your brick model generations and orders." url="https://brickbuilder.ai/dashboard" noIndex />
      <div className="flex">
        <Sidebar 
          active={tab} 
          onChange={handleTabChange} 
          onLogout={handleLogout}
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          showLogout={isSupabaseConfigured}
        />

        {/* Right column */}
        <div className="flex-1 min-w-0 flex flex-col w-full">
          {/* Header */}
          <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-slate-200">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3">
              <div className="flex items-center justify-between gap-2 sm:gap-4">
                {/* Mobile menu button */}
                <button
                  onClick={() => setMobileMenuOpen(true)}
                  className="lg:hidden p-2 hover:bg-slate-100 rounded-lg"
                  aria-label="Open menu"
                >
                  <Menu className="w-5 h-5" />
                </button>
                
                <div className="flex-1 min-w-0 flex items-center justify-end gap-2 sm:gap-4">
                  <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
                    <button
                      className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
                      onClick={() => navigate('/community')}
                    >
                      <Users className="h-4 w-4" />
                      Community
                    </button>
                    <button
                      onClick={() => navigate('/')}
                      className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-full text-white text-xs sm:text-sm font-medium transition-all bg-[#f44336] hover:bg-[#ff6b6b] hover:-translate-y-0.5 hover:shadow-lg cursor-pointer"
                    >
                      <Sparkles className="w-4 h-4" /> 
                      <span className="hidden sm:inline">Create New Model</span>
                      <span className="sm:hidden">Create</span>
                    </button>
                    <NotificationMenu />
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 py-4 sm:py-6">
              {tab==="dashboard" && (
                <>
                  <div className="mb-4 sm:mb-6">
                    <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-1">Welcome back, {displayName}!</h1>
                    <p className="text-sm sm:text-base text-slate-600">Here's what's happening with your builds</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-6">
                    <StatsCard icon={Sparkles}    label="Total Generations" value={stats.total} onClick={()=>setTab("generations")} />
                    <StatsCard icon={Package}     label="Total Orders"      value={stats.orders} onClick={()=>setTab("orders")} />
                    <StatsCard icon={Coins}       label="Credits Remaining"  value={stats.credits} />
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg sm:text-xl font-extrabold text-slate-900">Recent Generations</h2>
                    <button onClick={()=>setTab("generations")} className="flex items-center gap-1 sm:gap-2 font-medium text-xs sm:text-sm text-[#f44336] hover:underline">
                      View all <ChevronRight className="w-3 h-3 sm:w-4 sm:h-4"/>
                    </button>
                  </div>
                  
                  {loadingGenerations ? (
                    <div className="text-center py-8 text-sm sm:text-base text-slate-500">Loading generations...</div>
                  ) : generations.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-8 sm:p-12 text-center">
                      <Sparkles className="w-10 h-10 mx-auto mb-2 text-slate-400"/>
                      <div className="text-lg font-semibold text-slate-700 mb-1">No generations yet</div>
                      <p className="text-slate-500 mb-4">Create your first LEGO model to get started!</p>
                      <button 
                        onClick={() => navigate('/')}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-medium bg-[#f44336] hover:bg-[#ff6b6b]"
                      >
                        <Sparkles className="w-4 h-4" /> Create New Model
                      </button>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {generations.slice(0, 5).map(g => (
                        <GenerationCard key={g.id} g={g} onView={handleViewGeneration} authToken={session?.access_token} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab==="generations" && (
                <div>
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3 sm:mb-4">My Generations</h1>
                  {loadingGenerations ? (
                    <div className="text-center py-8 text-slate-500">Loading generations...</div>
                  ) : generations.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
                      <Sparkles className="w-10 h-10 mx-auto mb-2 text-slate-400"/>
                      <div className="text-lg font-semibold text-slate-700 mb-1">No generations yet</div>
                      <p className="text-slate-500">Create your first LEGO model to get started!</p>
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-3">
                        {generations.map(g => (
                          <GenerationCard key={g.id} g={g} onView={handleViewGeneration} authToken={session?.access_token} />
                        ))}
                      </div>
                      {hasMore && (
                        <div className="flex justify-center mt-6">
                          <button
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {loadingMore ? (
                              <>
                                <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
                                Loading...
                              </>
                            ) : (
                              'Load More'
                            )}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {tab==="orders" && (
                <div>
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3 sm:mb-4">My Orders</h1>
                  {loadingGenerations ? (
                    <div className="text-center py-8 text-slate-500">Loading orders...</div>
                  ) : orders.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
                      <Package className="w-10 h-10 mx-auto mb-2 text-slate-400"/>
                      <div className="text-lg font-semibold text-slate-700 mb-1">No orders yet</div>
                      <p className="text-slate-500">Order a kit to see it here!</p>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {orders.map(g => (
                        <OrderCard key={g.id} g={g} onView={() => handleViewGeneration(g.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab==="settings" && <SettingsPanel />}
            </div>
          </main>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
};

export default UserDashboard;
