from __future__ import annotations

from typing import Any

import boto3
from botocore.exceptions import ClientError

from .config import get_settings


def s3_client() -> Any:
    settings = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
    )


def initialize_bucket() -> None:
    bucket = get_settings().s3_bucket
    client = s3_client()
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError:
        client.create_bucket(Bucket=bucket)


def put_image(key: str, data: bytes, content_type: str) -> None:
    client = s3_client()
    client.put_object(Bucket=get_settings().s3_bucket, Key=key, Body=data, ContentType=content_type)


def delete_image(key: str) -> None:
    s3_client().delete_object(Bucket=get_settings().s3_bucket, Key=key)


def read_image(key: str) -> bytes:
    response = s3_client().get_object(Bucket=get_settings().s3_bucket, Key=key)
    return response["Body"].read()
