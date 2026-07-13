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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_events: {
        Row: {
          actor_user_id: string | null
          correlation_id: string | null
          created_at: string
          entity_crm_id: string | null
          entity_scope: Database["public"]["Enums"]["import_scope"] | null
          id: string
          kind: string
          next: Json | null
          previous: Json | null
          reason: string | null
        }
        Insert: {
          actor_user_id?: string | null
          correlation_id?: string | null
          created_at?: string
          entity_crm_id?: string | null
          entity_scope?: Database["public"]["Enums"]["import_scope"] | null
          id?: string
          kind: string
          next?: Json | null
          previous?: Json | null
          reason?: string | null
        }
        Update: {
          actor_user_id?: string | null
          correlation_id?: string | null
          created_at?: string
          entity_crm_id?: string | null
          entity_scope?: Database["public"]["Enums"]["import_scope"] | null
          id?: string
          kind?: string
          next?: Json | null
          previous?: Json | null
          reason?: string | null
        }
        Relationships: []
      }
      crm_config: {
        Row: {
          api_base_url: string
          building_object_id: string | null
          building_object_key: string
          id: number
          location_id: string | null
          opportunity_pipeline_id: string | null
          project_object_id: string | null
          project_object_key: string
          stage_closed_id: string | null
          stage_release_id: string | null
          stage_reserved_id: string | null
          stage_under_contract_id: string | null
          template_xlsx_url: string | null
          unit_object_id: string | null
          unit_object_key: string
          updated_at: string
        }
        Insert: {
          api_base_url?: string
          building_object_id?: string | null
          building_object_key?: string
          id?: number
          location_id?: string | null
          opportunity_pipeline_id?: string | null
          project_object_id?: string | null
          project_object_key?: string
          stage_closed_id?: string | null
          stage_release_id?: string | null
          stage_reserved_id?: string | null
          stage_under_contract_id?: string | null
          template_xlsx_url?: string | null
          unit_object_id?: string | null
          unit_object_key?: string
          updated_at?: string
        }
        Update: {
          api_base_url?: string
          building_object_id?: string | null
          building_object_key?: string
          id?: number
          location_id?: string | null
          opportunity_pipeline_id?: string | null
          project_object_id?: string | null
          project_object_key?: string
          stage_closed_id?: string | null
          stage_release_id?: string | null
          stage_reserved_id?: string | null
          stage_under_contract_id?: string | null
          template_xlsx_url?: string | null
          unit_object_id?: string | null
          unit_object_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      crm_pipelines: {
        Row: {
          created_at: string
          id: string
          label: string | null
          pipeline_id: string
          pipeline_name: string | null
          stage_closed_id: string | null
          stage_closed_name: string | null
          stage_release_id: string | null
          stage_release_name: string | null
          stage_reserved_id: string | null
          stage_reserved_name: string | null
          stage_under_contract_id: string | null
          stage_under_contract_name: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          pipeline_id: string
          pipeline_name?: string | null
          stage_closed_id?: string | null
          stage_closed_name?: string | null
          stage_release_id?: string | null
          stage_release_name?: string | null
          stage_reserved_id?: string | null
          stage_reserved_name?: string | null
          stage_under_contract_id?: string | null
          stage_under_contract_name?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          pipeline_id?: string
          pipeline_name?: string | null
          stage_closed_id?: string | null
          stage_closed_name?: string | null
          stage_release_id?: string | null
          stage_release_name?: string | null
          stage_reserved_id?: string | null
          stage_reserved_name?: string | null
          stage_under_contract_id?: string | null
          stage_under_contract_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      external_id_map: {
        Row: {
          code: string | null
          created_at: string
          crm_record_id: string
          display_name: string | null
          external_import_id: string
          first_seen_job_id: string | null
          id: string
          parent_crm_id: string | null
          scope: Database["public"]["Enums"]["import_scope"]
          updated_at: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          crm_record_id: string
          display_name?: string | null
          external_import_id: string
          first_seen_job_id?: string | null
          id?: string
          parent_crm_id?: string | null
          scope: Database["public"]["Enums"]["import_scope"]
          updated_at?: string
        }
        Update: {
          code?: string | null
          created_at?: string
          crm_record_id?: string
          display_name?: string | null
          external_import_id?: string
          first_seen_job_id?: string | null
          id?: string
          parent_crm_id?: string | null
          scope?: Database["public"]["Enums"]["import_scope"]
          updated_at?: string
        }
        Relationships: []
      }
      import_items: {
        Row: {
          action: Database["public"]["Enums"]["import_action"]
          correlation_id: string | null
          created_at: string
          existing: Json | null
          external_import_id: string | null
          id: string
          import_row_id: string | null
          job_id: string
          matched_crm_id: string | null
          messages: Json | null
          proposed: Json | null
          row_number: number | null
          scope: Database["public"]["Enums"]["import_scope"]
          source: Json | null
          status: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["import_action"]
          correlation_id?: string | null
          created_at?: string
          existing?: Json | null
          external_import_id?: string | null
          id?: string
          import_row_id?: string | null
          job_id: string
          matched_crm_id?: string | null
          messages?: Json | null
          proposed?: Json | null
          row_number?: number | null
          scope: Database["public"]["Enums"]["import_scope"]
          source?: Json | null
          status?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["import_action"]
          correlation_id?: string | null
          created_at?: string
          existing?: Json | null
          external_import_id?: string | null
          id?: string
          import_row_id?: string | null
          job_id?: string
          matched_crm_id?: string | null
          messages?: Json | null
          proposed?: Json | null
          row_number?: number | null
          scope?: Database["public"]["Enums"]["import_scope"]
          source?: Json | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "import_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      import_jobs: {
        Row: {
          buildings_created: number
          buildings_updated: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          errors_count: number
          file_hash: string | null
          filename: string | null
          id: string
          mode: string | null
          projects_created: number
          projects_updated: number
          report: Json | null
          row_count: number
          skipped: number
          started_at: string | null
          status: Database["public"]["Enums"]["import_status"]
          units_created: number
          units_updated: number
          updated_at: string
          user_id: string | null
          validation_snapshot: Json | null
          warnings_count: number
        }
        Insert: {
          buildings_created?: number
          buildings_updated?: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          errors_count?: number
          file_hash?: string | null
          filename?: string | null
          id?: string
          mode?: string | null
          projects_created?: number
          projects_updated?: number
          report?: Json | null
          row_count?: number
          skipped?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["import_status"]
          units_created?: number
          units_updated?: number
          updated_at?: string
          user_id?: string | null
          validation_snapshot?: Json | null
          warnings_count?: number
        }
        Update: {
          buildings_created?: number
          buildings_updated?: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          errors_count?: number
          file_hash?: string | null
          filename?: string | null
          id?: string
          mode?: string | null
          projects_created?: number
          projects_updated?: number
          report?: Json | null
          row_count?: number
          skipped?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["import_status"]
          units_created?: number
          units_updated?: number
          updated_at?: string
          user_id?: string | null
          validation_snapshot?: Json | null
          warnings_count?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_jobs: {
        Row: {
          created_count: number
          error_count: number
          error_summary: string | null
          finished_at: string | null
          id: string
          processed: number
          scope: string
          started_at: string
          started_by: string | null
          status: string
          total: number
          updated_count: number
        }
        Insert: {
          created_count?: number
          error_count?: number
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          processed?: number
          scope: string
          started_at?: string
          started_by?: string | null
          status?: string
          total?: number
          updated_count?: number
        }
        Update: {
          created_count?: number
          error_count?: number
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          processed?: number
          scope?: string
          started_at?: string
          started_by?: string | null
          status?: string
          total?: number
          updated_count?: number
        }
        Relationships: []
      }
      unit_state: {
        Row: {
          availability: string | null
          building_crm_id: string | null
          project_crm_id: string | null
          stage: string | null
          unit_crm_id: string
          updated_at: string
        }
        Insert: {
          availability?: string | null
          building_crm_id?: string | null
          project_crm_id?: string | null
          stage?: string | null
          unit_crm_id: string
          updated_at?: string
        }
        Update: {
          availability?: string | null
          building_crm_id?: string | null
          project_crm_id?: string | null
          stage?: string | null
          unit_crm_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          id: string
          opportunity_id: string | null
          outcome: string | null
          pipeline_id: string | null
          processed_at: string | null
          provider_event_id: string | null
          raw: Json | null
          received_at: string
          stage_id: string | null
          unit_crm_id: string | null
        }
        Insert: {
          id?: string
          opportunity_id?: string | null
          outcome?: string | null
          pipeline_id?: string | null
          processed_at?: string | null
          provider_event_id?: string | null
          raw?: Json | null
          received_at?: string
          stage_id?: string | null
          unit_crm_id?: string | null
        }
        Update: {
          id?: string
          opportunity_id?: string | null
          outcome?: string | null
          pipeline_id?: string | null
          processed_at?: string | null
          provider_event_id?: string | null
          raw?: Json | null
          received_at?: string
          stage_id?: string | null
          unit_crm_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "importer" | "viewer" | "pending"
      import_action: "create" | "update" | "skip" | "error"
      import_scope: "project" | "building" | "unit"
      import_status:
        | "validating"
        | "awaiting_confirm"
        | "running"
        | "success"
        | "success_with_warnings"
        | "partial_failure"
        | "failed"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "importer", "viewer", "pending"],
      import_action: ["create", "update", "skip", "error"],
      import_scope: ["project", "building", "unit"],
      import_status: [
        "validating",
        "awaiting_confirm",
        "running",
        "success",
        "success_with_warnings",
        "partial_failure",
        "failed",
      ],
    },
  },
} as const
