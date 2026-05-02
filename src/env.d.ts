/// <reference types="next" />

declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_SUPABASE_URL?: string
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
    /** YELLOW_AI */
    NEXT_PUBLIC_AI_BASE_URL?: string
    NEXT_PUBLIC_AI_API_KEY?: string
    NEXT_PUBLIC_AI_MODEL?: string
  }
}
