import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { normalizeRotation, type ImageRotation } from "@/lib/image-rotation";

export const DOCUMENT_IMAGE_ROTATION_QUERY_KEY = "document-image-rotation";

/** The clockwise rotation saved for one stored image path (0 when unknown). */
export function useImageRotation(imagePath?: string | null) {
  const enabled = typeof imagePath === "string" && imagePath.trim().length > 0;
  return useQuery({
    queryKey: [DOCUMENT_IMAGE_ROTATION_QUERY_KEY, imagePath],
    enabled,
    queryFn: async (): Promise<ImageRotation> => {
      const { data, error } = await (supabase as any)
        .from("document_image_rotations")
        .select("rotation")
        .eq("image_path", imagePath)
        .maybeSingle();
      if (error) throw error;
      return normalizeRotation(data?.rotation);
    },
  });
}

export interface SetImageRotationInput {
  imagePath: string;
  rotation: ImageRotation;
}

/** Save a manual rotation (warehouse / receipt editors); AI can no longer overwrite it. */
export function useSetImageRotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ imagePath, rotation }: SetImageRotationInput): Promise<ImageRotation> => {
      const { error } = await (supabase as any).rpc("set_document_image_rotation", {
        p_image_path: imagePath,
        p_rotation: rotation,
      });
      if (error) throw error;
      return rotation;
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData(
        [DOCUMENT_IMAGE_ROTATION_QUERY_KEY, variables.imagePath],
        normalizeRotation(variables.rotation),
      );
    },
  });
}
