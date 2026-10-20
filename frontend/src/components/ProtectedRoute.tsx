import React, { ReactNode, useState, useEffect } from 'react';
import { Mail, Check, AlertCircle } from 'lucide-react';
import { SendWaitlistEmailApiService } from '../services/sendWaitlistEmailApi';

interface ProtectedRouteProps {
  children: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  
  // Waitlist state
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [isWaitlistSubmitted, setIsWaitlistSubmitted] = useState(false);
  const [isWaitlistLoading, setIsWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [emailSentSuccessfully, setEmailSentSuccessfully] = useState(false);
  const [showPasswordSection, setShowPasswordSection] = useState(false);

  // Check if user is already authenticated (stored in localStorage)
  useEffect(() => {
    const storedPassword = localStorage.getItem('app-password');
    if (storedPassword === 'redmoon1') {
      setIsAuthenticated(true);
    }
  }, []);

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === 'redmoon1') {
      setIsAuthenticated(true);
      localStorage.setItem('app-password', password);
      setError('');
    } else {
      setError('Incorrect password');
      setPassword('');
    }
  };

  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!waitlistEmail) return;

    // Validate email format
    if (!isValidEmail(waitlistEmail.trim())) {
      setWaitlistError('Please enter a valid email address.');
      return;
    }

    setIsWaitlistLoading(true);
    setWaitlistError(null);

    try {
      const result = await SendWaitlistEmailApiService.sendWaitlistEmail(waitlistEmail);

      if (result.already_on_waitlist) {
        // Email already on waitlist
        setWaitlistError('This email is already on the waitlist!');
      } else if (result.success) {
        // Successfully added to waitlist
        setEmailSentSuccessfully(result.email_sent);
        setIsWaitlistSubmitted(true);
        setWaitlistEmail('');
        console.log(result.message);
      } else {
        // Something went wrong
        setWaitlistError(result.error || 'Something went wrong. Please try again.');
      }
    } catch (err) {
      setWaitlistError('Something went wrong. Please try again.');
      console.error('Error:', err);
    } finally {
      setIsWaitlistLoading(false);
    }
  };

  // If user is not authenticated, show password screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 py-8 px-4">
        <div className="mb-8">
          <div style={{ display: "inline-flex", alignItems: "center", gap: "0px" }}>
            <span style={{ fontSize: "32px", fontWeight: "800", color: "#ef4444", letterSpacing: "-0.5px" }}>BRICK</span>
            <span style={{ fontSize: "32px", fontWeight: "800", color: "#1e293b", letterSpacing: "-0.5px" }}>BUILDER</span>
          </div>
        </div>

        {/* Waitlist Section */}
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full mx-4">
          <h1 className="text-3xl font-bold text-center mb-6 text-gray-800">
            Join the Waitlist!
          </h1>
          <p className="text-sm text-gray-600 text-center mb-6">
            Get notified when we launch! Coming Q1 2026.
          </p>

          {!isWaitlistSubmitted ? (
            <div className="space-y-4">
              <form onSubmit={handleWaitlistSubmit} className="space-y-4">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="email"
                    placeholder="Enter your email address"
                    value={waitlistEmail}
                    onChange={(e) => {
                      setWaitlistEmail(e.target.value);
                      setWaitlistError(null);
                    }}
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                    disabled={isWaitlistLoading}
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={isWaitlistLoading || !waitlistEmail.trim()}
                  className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {isWaitlistLoading ? 'Joining...' : 'Join Waitlist'}
                </button>
              </form>

              <button
                onClick={() => setShowPasswordSection(true)}
                className="text-blue-600 underline text-sm hover:text-blue-700 transition-colors cursor-pointer"
              >
                Have an access code?
              </button>

              {waitlistError && (
                <div className="flex items-center gap-2 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{waitlistError}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <Check className="w-8 h-8 text-green-500" />
              </div>
              <h4 className="text-lg font-semibold text-gray-800">You're on the list!</h4>
              {emailSentSuccessfully ? (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    You should receive a welcome email.
                  </p>
                </div>
              ) : (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-yellow-800">
                    There was an issue sending the welcome email.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* YouTube Video */}
        <div className="mt-8 rounded-lg overflow-hidden shadow-lg" style={{ width: '315px', height: '560px' }}>
          <iframe
            width="315"
            height="560"
            src="https://www.youtube.com/embed/gYX0aafSzuw"
            title="See BrickBuilder in action"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ border: 'none' }}
          />
        </div>

        {/* Password Section */}
        {showPasswordSection && (
          <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full mx-4 mt-6">
          <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">
            Access Code
          </h2>
          <form onSubmit={handlePasswordSubmit}>
            <div className="mb-4">
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter access code"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            {error && (
              <p className="text-red-500 text-sm mb-4 text-center">{error}</p>
            )}
            <button
              type="submit"
              className="w-full bg-[#f44336] text-white py-2 px-4 rounded-lg hover:bg-[#f44336]/70 transition-colors"
            >
              Access App
            </button>
          </form>
        </div>
        )}
      </div>
    );
  }

  // User is authenticated, render the children
  return <>{children}</>;
}