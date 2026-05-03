/**
 * Öffentliches Schema — manuell an Migrationen unter `supabase/migrations/` angeglichen.
 * Neu generieren: `npm run db:types` (überschreibt diese Datei bei erfolgreichem `supabase link`).
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          id: string
          organization_id: string
          role: string
          display_name: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          organization_id: string
          role?: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          role?: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      workspace_documents: {
        Row: {
          organization_id: string
          doc_type: string
          body: Json
          updated_at: string
          created_at: string
        }
        Insert: {
          organization_id: string
          doc_type: string
          body?: Json
          updated_at?: string
          created_at?: string
        }
        Update: {
          organization_id?: string
          doc_type?: string
          body?: Json
          updated_at?: string
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
