/*
  Warnings:

  - You are about to drop the column `trial_days` on the `saas_plan` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "platform"."saas_plan" DROP COLUMN "trial_days";
