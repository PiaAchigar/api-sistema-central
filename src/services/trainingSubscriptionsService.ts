import { notFound, badRequest } from "../lib/errors";
import { activitiesService } from "./activitiesService";
import type { TrainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";

/**
 * TrainingSubscriptionsService — Business logic layer for training subscriptions
 * Validates business rules and delegates to repository
 * Singleton with repository dependency injection
 */
export class TrainingSubscriptionsService {
  constructor(private repository: TrainingSubscriptionsRepository) {}

  /**
   * Validate subscription dates
   * - subscriptionStartDate must be in YYYY-MM-DD format
   * - subscriptionEndDate (if provided) must be >= subscriptionStartDate
   *
   * @throws badRequest if validation fails
   */
  private validateDates(
    startDate: string,
    endDate?: string | null
  ): void {
    // Basic format validation
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      throw badRequest("subscriptionStartDate must be in YYYY-MM-DD format");
    }

    if (endDate) {
      if (!dateRegex.test(endDate)) {
        throw badRequest("subscriptionEndDate must be in YYYY-MM-DD format");
      }

      // End date must be >= start date
      if (new Date(endDate) < new Date(startDate)) {
        throw badRequest("subscriptionEndDate must be greater than or equal to subscriptionStartDate");
      }
    }
  }

  /**
   * Create a new training subscription with validation
   * @param data Subscription data to create
   * @returns Full created subscription record
   * @throws badRequest if validation fails
   * @throws notFound if activity doesn't exist
   */
  async createSubscription(data: {
    activityId: string;
    customerId: string;
    subscriptionStartDate: string;
    subscriptionEndDate?: string | null;
    monthlyAmount: number | string;
    notes?: string | null;
  }) {
    // Validate dates
    this.validateDates(data.subscriptionStartDate, data.subscriptionEndDate);

    // Validate activity exists
    try {
      await activitiesService.getActivity(data.activityId);
    } catch (err) {
      throw badRequest("Activity not found or inactive");
    }

    // Validate monthlyAmount is positive
    const amount = typeof data.monthlyAmount === "string"
      ? parseFloat(data.monthlyAmount)
      : data.monthlyAmount;
    if (amount <= 0) {
      throw badRequest("monthlyAmount must be greater than 0");
    }

    // Create via repository with default status
    const created = await this.repository.create({
      activityId: data.activityId,
      customerId: data.customerId,
      subscriptionStartDate: data.subscriptionStartDate,
      subscriptionEndDate: data.subscriptionEndDate || null,
      status: "active",
      monthlyAmount: data.monthlyAmount,
      notes: data.notes || null,
    });

    if (!created) {
      throw badRequest("Failed to create subscription");
    }

    return created;
  }

  /**
   * Get subscription by ID
   * @param id Subscription ID
   * @returns Subscription record
   * @throws notFound if subscription not found
   */
  async getSubscription(id: string) {
    const subscription = await this.repository.getById(id);
    if (!subscription) {
      throw notFound("Subscription");
    }
    return subscription;
  }

  /**
   * List subscriptions for a customer
   * @param customerId Customer ID
   * @returns Array of subscriptions
   */
  async listSubscriptions(customerId: string) {
    return this.repository.listByCustomerId(customerId);
  }

  /**
   * Update subscription with validation
   * @param id Subscription ID
   * @param data Partial subscription data to update
   * @returns Updated subscription record
   * @throws notFound if subscription not found
   * @throws badRequest if validation fails
   */
  async updateSubscription(
    id: string,
    data: {
      status?: "active" | "paused" | "cancelled";
      monthlyAmount?: number | string;
      subscriptionEndDate?: string | null;
      notes?: string | null;
    }
  ) {
    // Verify subscription exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Subscription");
    }

    // Validate dates if subscriptionEndDate is being updated
    if (data.subscriptionEndDate !== undefined) {
      this.validateDates(
        existing.subscriptionStartDate as any,
        data.subscriptionEndDate
      );
    }

    // Validate monthlyAmount if being updated
    if (data.monthlyAmount !== undefined) {
      const amount = typeof data.monthlyAmount === "string"
        ? parseFloat(data.monthlyAmount)
        : data.monthlyAmount;
      if (amount <= 0) {
        throw badRequest("monthlyAmount must be greater than 0");
      }
    }

    // Validate status if being updated
    if (data.status !== undefined) {
      if (!["active", "paused", "cancelled"].includes(data.status)) {
        throw badRequest("status must be one of: active, paused, cancelled");
      }
    }

    // Update via repository
    const updated = await this.repository.update(id, data);
    if (!updated) {
      throw notFound("Subscription");
    }

    return updated;
  }

  /**
   * Get attendance summary for a subscription in a specific month
   * @param subscriptionId Subscription ID
   * @param year Year (e.g., 2026)
   * @param month Month (1-12)
   * @returns Object with month name, total classes, attended count, and detailed records
   * @throws notFound if subscription not found
   * @throws badRequest if date parameters are invalid
   */
  async getMonthlyAttendance(subscriptionId: string, year: number, month: number) {
    // Verify subscription exists
    const subscription = await this.repository.getById(subscriptionId);
    if (!subscription) {
      throw notFound("Subscription");
    }

    // Validate year and month
    if (year < 1900 || year > 2100) {
      throw badRequest("year must be between 1900 and 2100");
    }
    if (month < 1 || month > 12) {
      throw badRequest("month must be between 1 and 12");
    }

    // Get attendance records for the month
    const attendance = await this.repository.getAttendanceForMonth(
      subscriptionId,
      year,
      month
    );

    // Calculate statistics
    const attended = attendance.filter((a) => a.attended).length;
    const total = attendance.length;

    // Format month name
    const monthDate = new Date(year, month - 1, 1);
    const monthName = monthDate.toLocaleDateString("es-AR", {
      month: "long",
      year: "numeric",
    });

    return {
      subscriptionId,
      year,
      month,
      monthName,
      totalClasses: total,
      attendedCount: attended,
      records: attendance,
    };
  }
}

/**
 * Singleton instance of TrainingSubscriptionsService
 * Initialized with the trainingSubscriptionsRepository singleton
 * Usage: trainingSubscriptionsService.createSubscription(...) after app startup
 */
import { trainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";

export const trainingSubscriptionsService = new TrainingSubscriptionsService(
  trainingSubscriptionsRepository
);
