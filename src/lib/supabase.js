import { createClient } from '@supabase/supabase-js';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jxwynzsxyxzohlhkqmpt.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
console.log('✅ Supabase client initialized with REAL URL:', supabaseUrl);
