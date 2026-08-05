import { notFound, badRequest } from "../lib/errors";
import type { ActivitySchedulesRepository } from "../repositories/activitySchedulesRepository";
import { activitiesService } from "./activitiesService";

/**
 * ActivitySchedulesService — Business logic layer for activity schedules
 * Validates business rules and delegates to repository
 * Singleton with repository dependency injection
 */
export class ActivitySchedulesService {
  constructor(private repository: ActivitySchedulesRepository) {}

  /**
   * Validate dayOfWeek is in range 0-6
   * 0=Sunday, 1=Monday, ..., 6=Saturday
   *
   * @throws badRequest if validation fails
   */
  validateDayOfWeek(dayOfWeek: number): void {
    if (dayOfWeek < 0 || dayOfWeek > 6) {
      throw badRequest(
        "Invalid day_of_week. Must be 0 (Sunday) to 6 (Saturday)"
      );
    }
  }

  /**
   * Validate time format (HH:MM:SS)
   * @throws badRequest if validation fails
   */
  validateTimeFormat(time: string): void {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
    if (!timeRegex.test(time)) {
      throw badRequest("Invalid time format. Must be HH:MM:SS");
    }
  }

  /**
   * Validate that startTime is before endTime
   * @throws badRequest if validation fails
   */
  validateTimeRange(startTime: string, endTime: string): void {
    if (startTime >= endTime) {
      throw badRequest(
        "start_time must be before end_time"
      );
    }
  }

  /**
   * Validate machine assignment for activity type
   * - 'class' activities must not have a machine_id
   * - 'machine' activities must have a machine_id
   *
   * @throws badRequest if validation fails
   */
  validateMachineForActivityType(
    activityType: "class" | "machine",
    machineId: string | null | undefined
  ): void {
    if (activityType === "class" && machineId) {
      throw badRequest(
        "Activity type 'class' must not have a machine_id"
      );
    }
    if (activityType === "machine" && !machineId) {
      throw badRequest(
        "Activity type 'machine' requires a machine_id"
      );
    }
  }

  /**
   * Create a new activity schedule with validation
   * @param data Schedule data to create
   * @returns Full created schedule record
   * @throws badRequest if validation fails
   * @throws notFound if activity not found
   */
  async createSchedule(data: {
    activityId: string;
    machineId?: string | null;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    validFrom?: string | null;
    validUntil?: string | null;
  }) {
    // Validate day of week
    this.validateDayOfWeek(data.dayOfWeek);

    // Validate time formats
    this.validateTimeFormat(data.startTime);
    this.validateTimeFormat(data.endTime);

    // Validate time range
    this.validateTimeRange(data.startTime, data.endTime);

    // Verify activity exists and get type for machine validation
    const activity = await activitiesService.getActivity(data.activityId);

    // Validate machine assignment based on activity type
    this.validateMachineForActivityType(
      activity.activityType as "class" | "machine",
      data.machineId
    );

    // Create via repository
    const created = await this.repository.create(data);
    if (!created) {
      throw badRequest("Failed to create activity schedule");
    }

    return created;
  }

  /**
   * Get schedule by ID
   * @param id Schedule ID
   * @returns Schedule record
   * @throws notFound if schedule not found
   */
  async getSchedule(id: string) {
    const schedule = await this.repository.getById(id);
    if (!schedule) {
      throw notFound("Activity schedule");
    }
    return schedule;
  }

  /**
   * List active schedules for an activity
   * @param activityId Activity ID
   * @returns Array of schedules
   * @throws notFound if activity not found
   */
  async listSchedules(activityId: string) {
    // Verify activity exists
    await activitiesService.getActivity(activityId);

    return this.repository.listByActivityId(activityId);
  }

  /**
   * Update schedule with validation
   *
   * @param id Schedule ID
   * @param data Partial schedule data to update
   * @returns Updated schedule record
   * @throws notFound if schedule not found
   * @throws badRequest if validation fails
   */
  async updateSchedule(
    id: string,
    data: {
      machineId?: string | null;
      dayOfWeek?: number;
      startTime?: string;
      endTime?: string;
      validFrom?: string | null;
      validUntil?: string | null;
    }
  ) {
    // Verify schedule exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Activity schedule");
    }

    // Validate day of week if provided
    if (data.dayOfWeek !== undefined) {
      this.validateDayOfWeek(data.dayOfWeek);
    }

    // Validate time formats if provided
    if (data.startTime !== undefined) {
      this.validateTimeFormat(data.startTime);
    }
    if (data.endTime !== undefined) {
      this.validateTimeFormat(data.endTime);
    }

    // Validate time range if either time changed
    if (data.startTime !== undefined || data.endTime !== undefined) {
      const startTime = data.startTime ?? (existing.startTime as string);
      const endTime = data.endTime ?? (existing.endTime as string);
      this.validateTimeRange(startTime, endTime);
    }

    // Validate machine assignment if activity type could affect it
    if (data.machineId !== undefined) {
      const activity = await activitiesService.getActivity(
        existing.activityId as string
      );
      this.validateMachineForActivityType(
        activity.activityType as "class" | "machine",
        data.machineId
      );
    }

    // Update via repository
    const updated = await this.repository.update(id, data);
    if (!updated) {
      throw notFound("Activity schedule");
    }

    return updated;
  }

  /**
   * Soft-delete a schedule (set isActive to false)
   * @param id Schedule ID
   * @returns Soft-deleted schedule record
   * @throws notFound if schedule not found
   */
  async deleteSchedule(id: string) {
    // Verify schedule exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Activity schedule");
    }

    // Soft-delete via repository
    const deleted = await this.repository.softDelete(id);
    if (!deleted) {
      throw notFound("Activity schedule");
    }

    return deleted;
  }
}

/**
 * Singleton instance of ActivitySchedulesService
 * Initialized with the activitySchedulesRepository singleton
 * Usage: activitySchedulesService.createSchedule(...) after app startup
 */
import { activitySchedulesRepository } from "../repositories/activitySchedulesRepository";

export const activitySchedulesService = new ActivitySchedulesService(
  activitySchedulesRepository
);
