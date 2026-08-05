import { notFound, badRequest } from "../lib/errors";
import type { Db } from "../db/client";
import { ActivitiesRepository } from "../repositories/activitiesRepository";

/**
 * ActivitiesService — Business logic layer for activities
 * Validates business rules and delegates to repository
 */
export class ActivitiesService {
  private repository: ActivitiesRepository;

  constructor(private db: Db) {
    this.repository = new ActivitiesRepository(db);
  }

  /**
   * Validate activity_type constraints
   * - 'class' requires service_provider_id and classes_per_month > 0
   * - 'machine' requires classes_per_month = 0
   *
   * @throws badRequest if validation fails
   */
  validateActivityType(
    activityType: "class" | "machine",
    classesPerMonth: number,
    serviceProviderId?: string | null
  ): void {
    if (activityType === "class") {
      if (!serviceProviderId) {
        throw badRequest("Activity type 'class' requires a service_provider_id");
      }
      if (classesPerMonth <= 0) {
        throw badRequest(
          "Activity type 'class' requires classes_per_month to be greater than 0"
        );
      }
    } else if (activityType === "machine") {
      if (classesPerMonth !== 0) {
        throw badRequest(
          "Activity type 'machine' requires classes_per_month to be exactly 0"
        );
      }
    } else {
      throw badRequest("Invalid activity_type. Must be 'class' or 'machine'");
    }
  }

  /**
   * Create a new activity with validation
   * @param data Activity data to create
   * @returns Full created activity record
   * @throws badRequest if validation fails
   */
  async createActivity(data: {
    name: string;
    description?: string | null;
    activityType: "class" | "machine";
    serviceProviderId?: string | null;
    classesPerMonth: number;
    monthlyBasePrice: number | string;
  }) {
    // Validate business rules
    this.validateActivityType(
      data.activityType,
      data.classesPerMonth,
      data.serviceProviderId
    );

    // Create via repository
    const created = await this.repository.create(data);
    if (!created) {
      throw new Error("Failed to create activity");
    }

    return created;
  }

  /**
   * Get activity by ID
   * @param id Activity ID
   * @returns Activity record
   * @throws notFound if activity not found
   */
  async getActivity(id: string) {
    const activity = await this.repository.getById(id);
    if (!activity) {
      throw notFound("Activity");
    }
    return activity;
  }

  /**
   * List activities
   * @param onlyActive If true, return only active activities (default: true)
   * @returns Array of activities
   */
  async listActivities(onlyActive: boolean = true) {
    if (onlyActive) {
      return this.repository.listActive();
    }
    return this.repository.listAll();
  }

  /**
   * Update activity with validation
   * If classesPerMonth is being changed, revalidate the activity_type constraints
   *
   * @param id Activity ID
   * @param data Partial activity data to update
   * @returns Updated activity record
   * @throws notFound if activity not found
   * @throws badRequest if validation fails
   */
  async updateActivity(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      activityType?: "class" | "machine";
      serviceProviderId?: string | null;
      classesPerMonth?: number;
      monthlyBasePrice?: number | string;
    }
  ) {
    // Verify activity exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Activity");
    }

    // Build the new state for validation
    const newActivityType = data.activityType ?? (existing.activityType as "class" | "machine");
    const newClassesPerMonth =
      data.classesPerMonth ?? (existing.classesPerMonth || 0);
    const newServiceProviderId = data.serviceProviderId ?? existing.serviceProviderId;

    // Re-validate if either activity_type or classesPerMonth changed
    if (data.activityType !== undefined || data.classesPerMonth !== undefined) {
      this.validateActivityType(
        newActivityType,
        newClassesPerMonth,
        newServiceProviderId
      );
    }

    // Update via repository
    const updated = await this.repository.update(id, data);
    if (!updated) {
      throw notFound("Activity");
    }

    return updated;
  }

  /**
   * Soft-delete an activity (set isActive to false)
   * @param id Activity ID
   * @returns Soft-deleted activity record
   * @throws notFound if activity not found
   */
  async deleteActivity(id: string) {
    // Verify activity exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Activity");
    }

    // Soft-delete via repository
    const deleted = await this.repository.softDelete(id);
    if (!deleted) {
      throw notFound("Activity");
    }

    return deleted;
  }
}

/**
 * Factory function to create an ActivitiesService instance
 * Usage: const service = createActivitiesService(db)
 */
export function createActivitiesService(db: Db): ActivitiesService {
  return new ActivitiesService(db);
}
