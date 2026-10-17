import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import posthog from 'posthog-js';

const navigate = vi.fn();
const loginLocation = vi.hoisted(() => ({ search: '', state: null as { from: string } | null }));
const auth = {
  signIn: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
};

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');

  return {
    ...actual,
    useNavigate: () => navigate,
    useLocation: () => loginLocation,
  };
});

vi.mock('../src/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));

vi.mock('../src/components/SEO', () => ({
  SEO: () => null,
}));

vi.mock('../src/components/FallingBricks', () => ({
  default: () => null,
}));

vi.mock('../src/components/SiteFooter', () => ({
  SiteFooter: () => null,
}));

import LoginModal from '../src/components/LoginModal';
import LoginPage from '../src/pages/LoginPage';

function renderIntoBody(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(node);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function changeInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;

  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('login auth options', () => {
  beforeEach(() => {
    loginLocation.search = '';
    loginLocation.state = null;
    auth.signIn.mockReset();
    auth.signIn.mockResolvedValue({ error: null });
    auth.signInWithGoogle.mockReset();
    auth.signInWithGoogle.mockResolvedValue({ error: null });
    auth.signInWithOtp.mockReset();
    auth.signInWithOtp.mockResolvedValue({ error: null });
    auth.verifyOtp.mockReset();
    auth.verifyOtp.mockResolvedValue({ error: null });
    navigate.mockReset();
    vi.mocked(posthog.capture).mockClear();
    Object.defineProperty(window, 'scrollTo', {
      value: vi.fn(),
      writable: true,
    });
  });

  it('keeps the modal on the email flow by default and exposes a password toggle', () => {
    const { container, unmount } = renderIntoBody(
      <LoginModal open onClose={() => undefined} />,
    );

    try {
      expect(container.textContent).toContain('Enter email to login or sign-up.');
      expect(container.textContent).toContain('Continue with magic link');
      expect(container.querySelector('input[type="password"]')).toBeNull();

      const toggle = findButton(container, 'Use password');
      expect(toggle).toBeDefined();

      act(() => {
        toggle?.click();
      });

      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      expect(container.textContent).toContain('Use your email and password to sign in.');
      expect(posthog.capture).toHaveBeenCalledWith('auth_method_selected', {
        surface: 'login_modal',
        method: 'password',
      });
    } finally {
      unmount();
    }
  });

  it('submits password sign-in from the modal', async () => {
    const onSuccess = vi.fn();
    const { container, unmount } = renderIntoBody(
      <LoginModal open onClose={() => undefined} onSuccess={onSuccess} />,
    );

    try {
      act(() => {
        findButton(container, 'Use password')?.click();
      });

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const form = container.querySelector('form') as HTMLFormElement;

      changeInput(emailInput, 'builder@example.com');
      changeInput(passwordInput, 'secret-password');

      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(auth.signIn).toHaveBeenCalledWith('builder@example.com', 'secret-password');
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(localStorage.getItem('remember_email')).toBe('builder@example.com');
      expect(posthog.capture).toHaveBeenCalledWith('auth_password_login_submitted', {
        surface: 'login_modal',
        method: 'password',
      });
    } finally {
      unmount();
    }
  });

  it('lets the login page switch to password sign-in and navigate after success', async () => {
    const { container, unmount } = renderIntoBody(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    try {
      expect(container.textContent).toContain('Enter email to login or sign-up.');

      act(() => {
        findButton(container, 'Use password')?.click();
      });

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;

      changeInput(emailInput, 'reviewer@example.com');
      changeInput(passwordInput, 'app-store-password');
      const form = container.querySelector('form') as HTMLFormElement;

      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(auth.signIn).toHaveBeenCalledWith('reviewer@example.com', 'app-store-password');
      expect(navigate).toHaveBeenCalledWith('/dashboard');
      expect(posthog.capture).toHaveBeenCalledWith('auth_method_selected', {
        surface: 'login_page',
        method: 'password',
      });
    } finally {
      unmount();
    }
  });

  it('passes redirect targets into magic link requests', async () => {
    const modalRender = renderIntoBody(
      <LoginModal open onClose={() => undefined} redirectTo="/community" />,
    );

    try {
      changeInput(
        modalRender.container.querySelector('input[type="email"]') as HTMLInputElement,
        'modal@example.com',
      );

      await act(async () => {
        (modalRender.container.querySelector('form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });

      expect(auth.signInWithOtp).toHaveBeenCalledWith('modal@example.com', '/community');
    } finally {
      modalRender.unmount();
    }

    auth.signInWithOtp.mockClear();

    const pageRender = renderIntoBody(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    try {
      changeInput(
        pageRender.container.querySelector('input[type="email"]') as HTMLInputElement,
        'page@example.com',
      );

      await act(async () => {
        (pageRender.container.querySelector('form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });

      expect(auth.signInWithOtp).toHaveBeenCalledWith('page@example.com', '/dashboard');
    } finally {
      pageRender.unmount();
    }
  });

  it.each(['url', 'state'] as const)('starts OAuth login with password using %s context and returns to consent', async source => {
    const destination = '/oauth/consent?authorization_id=review-request';
    if (source === 'url') loginLocation.search = `?${new URLSearchParams({ next: destination })}`;
    else loginLocation.state = { from: destination };
    const { container, unmount } = renderIntoBody(<MemoryRouter><LoginPage /></MemoryRouter>);
    try {
      expect(container.textContent).toContain('Sign in to connect');
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      changeInput(container.querySelector('input[type="email"]') as HTMLInputElement, 'reviewer@example.com');
      changeInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'review-password');
      await act(async () => {
        container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(auth.signIn).toHaveBeenCalledWith('reviewer@example.com', 'review-password');
      expect(auth.signInWithOtp).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(destination);
    } finally {
      unmount();
    }
  });

  it('keeps the OAuth request when an alternative sign-in method is selected', async () => {
    const destination = '/oauth/consent?authorization_id=review-request';
    loginLocation.search = `?${new URLSearchParams({ next: destination })}`;
    const { container, unmount } = renderIntoBody(<MemoryRouter><LoginPage /></MemoryRouter>);
    try {
      await act(async () => findButton(container, 'Continue with Google')?.click());
      expect(auth.signInWithGoogle).toHaveBeenCalledWith(destination);
      act(() => findButton(container, 'Use magic link instead')?.click());
      changeInput(container.querySelector('input[type="email"]') as HTMLInputElement, 'reviewer@example.com');
      await act(async () => {
        container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(auth.signInWithOtp).toHaveBeenCalledWith('reviewer@example.com', destination);
    } finally {
      unmount();
    }
  });

  it('shows invalid password errors without sending a verification email or leaving the request', async () => {
    loginLocation.search = '?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dreview-request';
    auth.signIn.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    const { container, unmount } = renderIntoBody(<MemoryRouter><LoginPage /></MemoryRouter>);
    try {
      changeInput(container.querySelector('input[type="email"]') as HTMLInputElement, 'reviewer@example.com');
      changeInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'wrong-password');
      await act(async () => {
        container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(container.textContent).toContain('Invalid login credentials');
      expect(navigate).not.toHaveBeenCalled();
      expect(auth.signInWithOtp).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
