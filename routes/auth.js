import express from 'express';
import {  createClient  } from '@supabase/supabase-js';
import ws from 'ws';

const router = express.Router();

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://ovrlwgslzqvdofgkfcxl.supabase.co';

const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92cmx3Z3NsenF2ZG9mZ2tmY3hsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMzU5OTQsImV4cCI6MjEwMTYxMTk5NH0.1mcIfa4B40A6A4sGmJyxB6a3i0ApjzWYteB68K2k8tQ';

// Provide WebSocket polyfill for Node (required by supabase-js realtime on Render)
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    transport: ws,
  },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Register user
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
        }
      }
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Create profile record in users table
    if (data.user) {
      const { error: dbError } = await supabase.from("users").insert({
        id: data.user.id,
        full_name: name,
        email: data.user.email,
        onboarding_complete: false
      });
      
      if (dbError) {
        console.error("Error creating user profile:", dbError);
        // Continue anyway since auth succeeded
      }
    }

    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout user
router.post('/logout', async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
