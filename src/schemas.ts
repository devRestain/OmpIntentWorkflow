import { z } from '@oh-my-pi/omptype/zod';
export const requirementSchema = z.object({id:z.string().min(1),kind:z.enum(['outcome','constraint','permission','exclusion','acceptance']),text:z.string().min(1),version:z.number().int().positive(),sourceEventIds:z.array(z.number().int().positive()).min(1),scope:z.array(z.string()).optional()});
const checkSchema=z.object({command:z.array(z.string()).min(1),description:z.string()});
const workSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]+$/),title:z.string().min(1),instructions:z.string().min(1),dependencies:z.array(z.string()),requirementIds:z.array(z.string()),writePaths:z.array(z.string()),readPaths:z.array(z.string()).optional(),resources:z.array(z.string()),checks:z.array(checkSchema),role:z.enum(['lead','heavy','normal','light','reviewer']).optional(),model:z.string().min(1).optional()});
export const planSchema=z.object({title:z.string().min(1),summary:z.string().min(1),requirements:z.array(requirementSchema).min(1),assumptions:z.array(z.string()),proposals:z.array(z.string()),questions:z.array(z.string()),work:z.array(workSchema),checks:z.array(checkSchema)});
export const acknowledgementSchema=z.object({epoch:z.number().int().nonnegative(),attempt:z.number().int().nonnegative(),eventIds:z.array(z.number().int().positive())});
const correctionSchema=z.object({taskId:z.string().min(1),instructions:z.string().min(1)});
export const reportSchema=z.object({summary:z.string(),completed:z.array(z.string()),unmet:z.array(z.string()),findings:z.array(z.string()),pendingChecks:z.array(z.string()),corrections:z.array(correctionSchema)});
export const reviewSchema=z.object({passed:z.boolean(),findings:z.array(z.string()),corrections:z.array(correctionSchema)});
export const steeringSchema=z.object({kind:z.enum(['question','change','pause','resume','cancel','uncertain']),answer:z.string().optional(),requirements:z.array(requirementSchema).optional(),impactedTaskIds:z.array(z.string()).optional(),reason:z.string().optional(),work:z.array(workSchema).optional(),checks:z.array(checkSchema).optional(),resolvedEventIds:z.array(z.number().int().positive()).optional()});
export const ownerSchema=z.object({pid:z.number().int().positive(),token:z.string()});
export const pointerSchema=z.object({id:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)});
export function parseJSON(text:string):unknown { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
export function errorCode(error:unknown):string|undefined {return typeof error==='object'&&error!==null&&'code' in error&&typeof error.code==='string'?error.code:undefined;}
