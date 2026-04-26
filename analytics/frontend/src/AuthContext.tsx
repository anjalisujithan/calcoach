import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';
import { auth } from './firebase';

const API = process.env.REACT_APP_ANALYTICS_API ?? 'http://localhost:8001';
const CALENDAR_API = process.env.REACT_APP_CALENDAR_API ?? 'http://localhost:8000';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function registerInFirestore(user: User) {
  try {
    await fetch(`${API}/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        display_name: user.displayName ?? '',
      }),
    });
  } catch (e) {
    console.warn('Could not register user in Firestore:', e);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        await registerInFirestore(firebaseUser);
      }
      setLoading(false);
    });
  }, []);

  const signUp = async (email: string, password: string) => {
    const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password);
    await registerInFirestore(newUser);
  };

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();

    provider.addScope("https://www.googleapis.com/auth/calendar");

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    await registerInFirestore(result.user);

    if (accessToken) {
      await fetch(`${CALENDAR_API}/auth/google-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          access_token: accessToken,
          email: result.user.email,
        }),
      });
    }
  };

  const signOut = async () => {
    try {
      await fetch(`${CALENDAR_API}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (e) {
      console.warn('Calendar logout snapshot failed:', e);
    }
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
