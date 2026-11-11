// Supabase 개발 DB에서 생성한 타입. 재생성 절차: docs/infrastructure.md
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      analyses: {
        Row: {
          chat_id: string
          conditions_snapshot: Json
          created_at: string
          housing_type_id: string | null
          id: string
          notice_id: string | null
          rules_version: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_id: string
          conditions_snapshot?: Json
          created_at?: string
          housing_type_id?: string | null
          id?: string
          notice_id?: string | null
          rules_version?: string
          status?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_id?: string
          conditions_snapshot?: Json
          created_at?: string
          housing_type_id?: string | null
          id?: string
          notice_id?: string | null
          rules_version?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyses_chat_id_user_id_fkey"
            columns: ["chat_id", "user_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "analyses_housing_type_id_notice_id_fkey"
            columns: ["housing_type_id", "notice_id"]
            isOneToOne: false
            referencedRelation: "housing_types"
            referencedColumns: ["id", "notice_id"]
          },
          {
            foreignKeyName: "analyses_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          chat_id: string
          content: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          chat_id: string
          content: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          chat_id?: string
          content?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_chat_id_user_id_fkey"
            columns: ["chat_id", "user_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      chats: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      funding_entries: {
        Row: {
          amount_won: number
          analysis_id: string
          available_on: string
          certainty: string
          created_at: string
          id: string
          kind: string
          note: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_won: number
          analysis_id: string
          available_on: string
          certainty: string
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_won?: number
          analysis_id?: string
          available_on?: string
          certainty?: string
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "funding_entries_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      housing_types: {
        Row: {
          exclusive_area_m2: number | null
          external_type_id: string
          id: string
          label: string
          notice_id: string
          source_document_id: string | null
          source_page: number | null
          supply_area_m2: number | null
          supply_area_status: string
        }
        Insert: {
          exclusive_area_m2?: number | null
          external_type_id: string
          id?: string
          label: string
          notice_id: string
          source_document_id?: string | null
          source_page?: number | null
          supply_area_m2?: number | null
          supply_area_status?: string
        }
        Update: {
          exclusive_area_m2?: number | null
          external_type_id?: string
          id?: string
          label?: string
          notice_id?: string
          source_document_id?: string | null
          source_page?: number | null
          supply_area_m2?: number | null
          supply_area_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "housing_types_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "housing_types_source_document_id_notice_id_fkey"
            columns: ["source_document_id", "notice_id"]
            isOneToOne: false
            referencedRelation: "notice_documents"
            referencedColumns: ["id", "notice_id"]
          },
        ]
      }
      notice_documents: {
        Row: {
          collected_at: string
          edition_label: string | null
          id: string
          notice_id: string
          official_url: string
          sha256: string | null
          verification_status: string
        }
        Insert: {
          collected_at: string
          edition_label?: string | null
          id?: string
          notice_id: string
          official_url: string
          sha256?: string | null
          verification_status?: string
        }
        Update: {
          collected_at?: string
          edition_label?: string | null
          id?: string
          notice_id?: string
          official_url?: string
          sha256?: string | null
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notice_documents_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          address: string | null
          collected_at: string
          external_id: string
          id: string
          notice_kind: string
          official_url: string | null
          region_code: string | null
          source_id: string
          title: string
          verification_status: string
        }
        Insert: {
          address?: string | null
          collected_at: string
          external_id: string
          id?: string
          notice_kind: string
          official_url?: string | null
          region_code?: string | null
          source_id: string
          title: string
          verification_status?: string
        }
        Update: {
          address?: string | null
          collected_at?: string
          external_id?: string
          id?: string
          notice_kind?: string
          official_url?: string | null
          region_code?: string | null
          source_id?: string
          title?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notices_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "source_registry"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_change_requests: {
        Row: {
          base_revision: number
          created_at: string
          decided_at: string | null
          id: string
          proposed_changes: Json
          reason: string | null
          status: string
          user_id: string
        }
        Insert: {
          base_revision: number
          created_at?: string
          decided_at?: string | null
          id?: string
          proposed_changes: Json
          reason?: string | null
          status?: string
          user_id: string
        }
        Update: {
          base_revision?: number
          created_at?: string
          decided_at?: string | null
          id?: string
          proposed_changes?: Json
          reason?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_change_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      reports: {
        Row: {
          analysis_id: string
          conditions_snapshot: Json
          created_at: string
          id: string
          queried_at: string
          result_snapshot: Json
          snapshot_version: number
          sources_snapshot: Json
          unknowns_snapshot: Json
          user_id: string
        }
        Insert: {
          analysis_id: string
          conditions_snapshot: Json
          created_at?: string
          id?: string
          queried_at: string
          result_snapshot: Json
          snapshot_version: number
          sources_snapshot: Json
          unknowns_snapshot: Json
          user_id: string
        }
        Update: {
          analysis_id?: string
          conditions_snapshot?: Json
          created_at?: string
          id?: string
          queried_at?: string
          result_snapshot?: Json
          snapshot_version?: number
          sources_snapshot?: Json
          unknowns_snapshot?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      source_registry: {
        Row: {
          display_name: string
          documentation_url: string | null
          export_permission: string
          id: string
          llm_permission: string
          retention_days: number | null
          reuse_permission: string
          reviewed_at: string | null
          storage_permission: string
        }
        Insert: {
          display_name: string
          documentation_url?: string | null
          export_permission?: string
          id: string
          llm_permission?: string
          retention_days?: number | null
          reuse_permission?: string
          reviewed_at?: string | null
          storage_permission?: string
        }
        Update: {
          display_name?: string
          documentation_url?: string | null
          export_permission?: string
          id?: string
          llm_permission?: string
          retention_days?: number | null
          reuse_permission?: string
          reviewed_at?: string | null
          storage_permission?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          commute_destination: string | null
          created_at: string
          revision: number
          search_conditions: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          commute_destination?: string | null
          created_at?: string
          revision?: number
          search_conditions?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          commute_destination?: string | null
          created_at?: string
          revision?: number
          search_conditions?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      decide_profile_change: {
        Args: { decision: string; request_id: string }
        Returns: {
          base_revision: number
          created_at: string
          decided_at: string | null
          id: string
          proposed_changes: Json
          reason: string | null
          status: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "profile_change_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
