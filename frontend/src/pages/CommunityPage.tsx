import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Coins,
  Users,
  Loader2,
  Sparkles,
  LayoutDashboard,
  Heart,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { SEO } from "../components/SEO";
import { ProfileMenu } from "../components/ProfileMenu";
import {
  GetCommunityGenerationsApiService,
  CommunityGeneration,
} from "../services/getCommunityGenerationsApi";
import { ToggleGenerationLikeApiService } from "../services/toggleGenerationLikeApi";
import { SiteFooter } from "../components/SiteFooter";
import LoginModal from "../components/LoginModal";
import posthog from "posthog-js";

function CommunityHeader() {
  const navigate = useNavigate();
  const { user, userProfile, isSupabaseConfigured } = useAuth();

  // Show profile menu if user is logged in OR if Supabase is not configured
  const showProfileMenu = user || !isSupabaseConfigured;

  return (
    <header className="flex items-center justify-between w-full relative landing-fade-in landing-delay-1" style={{ zIndex: 50 }}>
      <a href="/" className="flex items-center gap-2 group">
        <ChevronLeft className="h-5 w-5 text-slate-500 group-hover:text-[#f44336] group-hover:-translate-x-0.5 transition-all" />
        <img
          src="/logo.svg"
          alt="BrickBuilder"
          className="h-7 w-auto"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
        />
        <span className="text-xl font-extrabold tracking-tight">
          <span className="text-[#ff4b4b]">BRICK</span>
          <span className="text-slate-900">BUILDER</span>
        </span>
      </a>

      <div className="flex items-center gap-3">
        {showProfileMenu ? (
          <>
            {/* Only show credits when user is logged in with Supabase */}
            {user && isSupabaseConfigured && (
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-full px-3 py-1.5">
                <Coins className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-700">
                  {userProfile?.credits ?? 0}
                </span>
              </div>
            )}

            <button
              className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
              onClick={() => navigate('/dashboard')}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>

            <div className="relative">
              <ProfileMenu />
            </div>
          </>
        ) : (
          <>
            <button
              className="bg-transparent text-slate-600 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-black hover:-translate-y-px"
              onClick={() => navigate("/login")}
            >
              Login
            </button>
            <button
              className="bg-[#f44336] text-white rounded-full px-4 h-9 border-none text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-[#ff6b6b] hover:-translate-y-px"
              onClick={() => navigate("/signup")}
            >
              Sign Up
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function CommunityCard({
  g,
  onClick,
  onLikeClick,
  liking,
}: {
  g: CommunityGeneration;
  onClick: () => void;
  onLikeClick: () => void;
  liking: boolean;
}) {
  const sourceImage = g.processed_image_url;
  const mainImage = g.preview_image_url || g.external_image_url || g.image_url || g.thumbnail_url || g.processed_image_url;
  const showOverlay = Boolean(g.preview_image_url && sourceImage);
  const title = g.name?.trim() || "Untitled Model";
  const truncated = title.length > 80 ? title.slice(0, 77) + "..." : title;
  const likeCount = g.like_count ?? 0;
  const liked = Boolean(g.viewer_has_liked);

  return (
    <article className="relative bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
      <button
        type="button"
        onClick={onClick}
        className="group block w-full text-left cursor-pointer p-0"
      >
        <div className="relative aspect-square w-full bg-slate-100 overflow-hidden flex items-center justify-center">
          {mainImage ? (
            <img
              src={mainImage}
              alt={truncated}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <Sparkles className="h-10 w-10 text-slate-300" />
          )}
          {showOverlay && (
            <div className="absolute top-2 right-2 w-1/4 aspect-square rounded-lg overflow-hidden border-2 border-white shadow-md bg-white flex items-center justify-center">
              <img
                src={sourceImage as string}
                alt=""
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.display = "none";
                }}
              />
            </div>
          )}
        </div>
        <div className="p-4">
          <div className="text-sm font-semibold text-slate-800 line-clamp-2 min-h-[2.5rem]">
            {truncated}
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 mt-2">
            {g.username?.trim() ? (
              <div className="text-xs text-slate-600 min-w-0 truncate order-1">
                <span className="text-slate-500">Created by: </span>
                <span className="font-medium text-slate-700">{g.username}</span>
              </div>
            ) : (
              <span className="hidden sm:block" />
            )}
            <div className="text-xs text-slate-500 flex-shrink-0 order-2">
              {new Date(g.created_at).toLocaleDateString()}
            </div>
          </div>
        </div>
      </button>
      <button
        type="button"
        aria-label={liked ? "Unlike community model" : "Like community model"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onLikeClick();
        }}
        disabled={liking}
        className={`absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur-sm transition-colors cursor-pointer ${
          liked
            ? 'border-rose-200 bg-white/95 text-rose-600'
            : 'border-white/80 bg-white/90 text-slate-700 hover:text-rose-600'
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {liking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Heart className={`h-3.5 w-3.5 ${liked ? 'fill-current' : ''}`} />
        )}
        {likeCount}
      </button>
    </article>
  );
}

export default function CommunityPage() {
  const navigate = useNavigate();
  const { session, user } = useAuth();
  const [generations, setGenerations] = useState<CommunityGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [likingGenerationId, setLikingGenerationId] = useState<string | null>(null);
  const PAGE_LIMIT = 50;

  const fetchCommunity = async (currentOffset: number, append: boolean = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await GetCommunityGenerationsApiService.getCommunityGenerations(
        session?.access_token || undefined,
        PAGE_LIMIT,
        currentOffset
      );

      // Sort by created_at desc, matching dashboard behavior
      const sorted = (response.generations || []).slice().sort((a, b) => {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      if (append) {
        setGenerations((prev) => [...prev, ...sorted]);
      } else {
        setGenerations(sorted);
      }
      setHasMore(Boolean(response.has_more));
    } catch (e) {
      console.error('Failed to fetch community generations:', e);
      setError(e instanceof Error ? e.message : 'Failed to load community models');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    setOffset(0);
    fetchCommunity(0);
    // Refetch when auth token changes (anonymous -> logged in)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_LIMIT;
    setOffset(newOffset);
    fetchCommunity(newOffset, true);
  };

  const handleLike = async (generation: CommunityGeneration) => {
    if (likingGenerationId === generation.id) return;

    if (!user) {
      setShowLoginModal(true);
      return;
    }

    const previousLiked = Boolean(generation.viewer_has_liked);
    const previousCount = generation.like_count ?? 0;
    const nextLiked = !previousLiked;
    const nextCount = Math.max(previousCount + (nextLiked ? 1 : -1), 0);

    setLikingGenerationId(generation.id);
    setError(null);
    setGenerations((prev) => prev.map((item) => (
      item.id === generation.id
        ? { ...item, viewer_has_liked: nextLiked, like_count: nextCount }
        : item
    )));

    posthog.capture('community_model_like_clicked', {
      generation_id: generation.id,
      has_liked: nextLiked,
      surface: 'community_grid',
      is_authenticated: true,
    });

    try {
      const response = await ToggleGenerationLikeApiService.toggleGenerationLike(
        generation.id,
        session?.access_token || undefined,
      );

      setGenerations((prev) => prev.map((item) => (
        item.id === generation.id
          ? {
              ...item,
              viewer_has_liked: response.has_liked,
              like_count: response.like_count,
            }
          : item
      )));
    } catch (likeError) {
      console.error('Failed to toggle community model like:', likeError);
      setGenerations((prev) => prev.map((item) => (
        item.id === generation.id
          ? {
              ...item,
              viewer_has_liked: previousLiked,
              like_count: previousCount,
            }
          : item
      )));
      setError(likeError instanceof Error ? likeError.message : 'Failed to update like');
    } finally {
      setLikingGenerationId(null);
    }
  };

  return (
    <>
      <SEO
        title="Community Models — BrickBuilder"
        description="Explore LEGO models shared by the BrickBuilder community."
      />
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        redirectTo="/community"
      />
      <div className="min-h-screen bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <CommunityHeader />

          <section className="mt-10 text-center landing-fade-in landing-delay-2">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-[#f44336]/10 mb-4">
              <Users className="h-7 w-7 text-[#f44336]" />
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">
              Community Models
            </h1>
            <p className="mt-3 text-slate-600 max-w-xl mx-auto">
              Browse brick models shared by builders in the BrickBuilder community.
            </p>
          </section>

          <section className="mt-10 landing-fade-in landing-delay-3">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
              </div>
            ) : error ? (
              <div className="text-center py-20">
                <p className="text-red-500 font-medium">{error}</p>
              </div>
            ) : generations.length === 0 ? (
              <div className="text-center py-20">
                <Sparkles className="h-10 w-10 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600 font-medium">No community models yet.</p>
                <p className="text-slate-500 text-sm mt-1">
                  Be the first to share your build!
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
                  {generations.map((g) => (
                    <CommunityCard
                      key={g.id}
                      g={g}
                      onClick={() => navigate(`/generated-model?id=${g.id}`)}
                      onLikeClick={() => {
                        void handleLike(g);
                      }}
                      liking={likingGenerationId === g.id}
                    />
                  ))}
                </div>
                {hasMore && (
                  <div className="flex justify-center mt-8">
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
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
          </section>
          <SiteFooter />
        </div>
      </div>
    </>
  );
}
