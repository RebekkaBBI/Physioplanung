/// <reference types="next" />

declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_SUPABASE_URL?: string
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
    /** YELLOW_AI */
    NEXT_PUBLIC_AI_BASE_URL?: string
    NEXT_PUBLIC_AI_API_KEY?: string
    NEXT_PUBLIC_AI_MODEL?: string
    /** Nur Server (Vercel): Supabase service_role / secret — niemals NEXT_PUBLIC_. */
    SUPABASE_SERVICE_ROLE_KEY?: string
    /** Geteilter Token für POST /api/admin/workspace (Header x-workspace-admin-secret). */
    WORKSPACE_ADMIN_SECRET?: string
  }
}
