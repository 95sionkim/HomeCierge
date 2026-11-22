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
          directory_request_key: string | null
          housing_type_id: string | null
          id: string
          latest_run_id: string | null
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
          directory_request_key?: string | null
          housing_type_id?: string | null
          id?: string
          latest_run_id?: string | null
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
          directory_request_key?: string | null
          housing_type_id?: string | null
          id?: string
          latest_run_id?: string | null
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
      analysis_input_snapshots: {
        Row: {
          analysis_id: string
          as_of: string
          capture_key: string
          conditions_snapshot: Json
          contract_version: string
          created_at: string
          data_origin: string
          edition: string
          house_manage_no: string
          housing_type_id: string | null
          id: string
          input_snapshot: Json
          notice_id: string | null
          notice_no: string
          notice_source: string
          page_size: number
          period_end: string | null
          period_start: string | null
          result_snapshot: Json
          rules_version: string
          target_binding_status: string
          user_id: string
        }
        Insert: {
          analysis_id: string
          as_of: string
          capture_key: string
          conditions_snapshot: Json
          contract_version: string
          created_at?: string
          data_origin: string
          edition: string
          house_manage_no: string
          housing_type_id?: string | null
          id?: string
          input_snapshot: Json
          notice_id?: string | null
          notice_no: string
          notice_source: string
          page_size: number
          period_end?: string | null
          period_start?: string | null
          result_snapshot: Json
          rules_version: string
          target_binding_status: string
          user_id: string
        }
        Update: {
          analysis_id?: string
          as_of?: string
          capture_key?: string
          conditions_snapshot?: Json
          contract_version?: string
          created_at?: string
          data_origin?: string
          edition?: string
          house_manage_no?: string
          housing_type_id?: string | null
          id?: string
          input_snapshot?: Json
          notice_id?: string | null
          notice_no?: string
          notice_source?: string
          page_size?: number
          period_end?: string | null
          period_start?: string | null
          result_snapshot?: Json
          rules_version?: string
          target_binding_status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analysis_input_snapshots_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      analysis_uploads: {
        Row: {
          analysis_id: string
          id: string
          object_path: string | null
          status: string
          user_id: string
        }
        Insert: {
          analysis_id: string
          id: string
          object_path?: string | null
          status?: string
          user_id: string
        }
        Update: {
          analysis_id?: string
          id?: string
          object_path?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analysis_uploads_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
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
          display_permission: string
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
          display_permission?: string
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
          display_permission?: string
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
      ingestion_collection_pages: {
        Row: {
          analysis_id: string | null
          collection_kind: string | null
          contract_month: string | null
          data_origin: string | null
          page: number | null
          page_size: number | null
          page_status: string | null
          record_id: string | null
          request_region_code: string | null
          request_scope: Json | null
          snapshot_id: string | null
          source_id: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_input_snapshots_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      ingestion_collections: {
        Row: {
          analysis_id: string | null
          collected_at: string | null
          collection_kind: string | null
          contract_month: string | null
          data_origin: string | null
          error: Json | null
          missing_pages: number[] | null
          page_size: number | null
          pages_expected: number | null
          reasons: Json | null
          record_id: string | null
          reported_total_count: number | null
          request_region_code: string | null
          request_scope: Json | null
          rows_received: number | null
          snapshot_id: string | null
          source_id: string | null
          status: string | null
          total_count_changed: boolean | null
          trade_kinds: Json | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_input_snapshots_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      ingestion_document_versions: {
        Row: {
          acquisition_source: string | null
          analysis_id: string | null
          data_origin: string | null
          document: Json | null
          document_id: string | null
          edition: string | null
          house_manage_no: string | null
          notice_no: string | null
          origin_check: string | null
          snapshot_id: string | null
          status: string | null
          user_id: string | null
          version: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_input_snapshots_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      ingestion_trade_observations: {
        Row: {
          amount_won: string | null
          analysis_id: string | null
          cancellation_status: string | null
          contract_date: string | null
          contract_month: string | null
          data_origin: string | null
          disposition: string | null
          exclusive_area_m2: string | null
          observation: Json | null
          page: number | null
          record_id: string | null
          request_region_code: string | null
          row_position: number | null
          snapshot_id: string | null
          source_id: string | null
          supply_area_m2: string | null
          trade_kind: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_input_snapshots_analysis_id_user_id_fkey"
            columns: ["analysis_id", "user_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Functions: {
      cancel_analysis_run: {
        Args: { p_analysis_id: string; p_run_id: string }
        Returns: Json
      }
      claim_analysis_run: {
        Args: { p_lease_seconds: number; p_run_id?: string }
        Returns: Json
      }
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
      enqueue_analysis_run: {
        Args: {
          p_analysis_id: string
          p_idempotency_key: string
          p_input: Json
        }
        Returns: Json
      }
      fail_analysis_run: {
        Args: {
          p_generation: number
          p_lease_token: string
          p_retryable: boolean
          p_run_id: string
        }
        Returns: Json
      }
      fail_notice_analysis_run: {
        Args: {
          p_error_code: string
          p_generation: number
          p_lease_token: string
          p_retryable: boolean
          p_run_id: string
        }
        Returns: Json
      }
      finalize_analysis_upload_deletion: {
        Args: { analysis_id: string; upload_id: string }
        Returns: {
          analysis_id: string
          id: string
          object_path: string | null
          status: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "analysis_uploads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finish_analysis_comparison: {
        Args: {
          p_comparison: Json
          p_generation: number
          p_input: Json
          p_lease_token: string
          p_result: Json
          p_run_id: string
        }
        Returns: Json
      }
      finish_analysis_run: {
        Args: {
          p_generation: number
          p_input: Json
          p_lease_token: string
          p_result: Json
          p_run_id: string
        }
        Returns: Json
      }
      get_analysis_comparison: {
        Args: { p_analysis_id: string; p_run_id: string }
        Returns: Json
      }
      get_analysis_run: {
        Args: { p_analysis_id: string; p_run_id: string }
        Returns: Json
      }
      prepare_analysis_regional_news: {
        Args: { p_analysis_id: string; p_snapshot_id: string }
        Returns: Json
      }
      publish_law_reference: { Args: { p_reference: Json }; Returns: undefined }
      publish_notice_directory: {
        Args: { p_index: Json; p_regions: Json }
        Returns: undefined
      }
      publish_notice_search_index: {
        Args: { p_index: Json }
        Returns: undefined
      }
      read_analysis_funding_inputs: {
        Args: {
          p_analysis_id: string
          p_model_no: string
          p_room: string
          p_snapshot_id: string
        }
        Returns: Json
      }
      read_analysis_legal_evidence: {
        Args: { p_analysis_id: string; p_snapshot_id: string }
        Returns: Json
      }
      read_comparison_work: {
        Args: { p_generation: number; p_lease_token: string; p_run_id: string }
        Returns: Json
      }
      read_notice_directory_index: { Args: never; Returns: Json }
      read_notice_search_index: { Args: never; Returns: Json }
      register_analysis_upload: {
        Args: { analysis_id: string; upload_id: string }
        Returns: {
          analysis_id: string
          id: string
          object_path: string | null
          status: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "analysis_uploads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      register_comparison_evidence: {
        Args: {
          p_evidence: Json
          p_snapshot_id: string
          p_source_ids: string[]
        }
        Returns: string
      }
      renew_analysis_run: {
        Args: {
          p_generation: number
          p_lease_seconds: number
          p_lease_token: string
          p_run_id: string
        }
        Returns: Json
      }
      request_analysis_upload_deletion: {
        Args: { analysis_id: string; upload_id: string }
        Returns: {
          analysis_id: string
          id: string
          object_path: string | null
          status: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "analysis_uploads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_funding_schedule_snapshot: {
        Args: {
          p_analysis_id: string
          p_capture_key: string
          p_input: Json
          p_result: Json
          p_schedules: Json
          p_user_id: string
        }
        Returns: string
      }
      save_ingestion_snapshot: {
        Args: {
          p_analysis_id: string
          p_capture_key: string
          p_input: Json
          p_result: Json
          p_user_id: string
        }
        Returns: string
      }
      start_notice_workspace: {
        Args: { p_input: Json; p_request_key: string }
        Returns: Json
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
