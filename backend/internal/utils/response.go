package utils

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Response struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data"`
}

func Success(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, Response{
		Code:    0,
		Message: "success",
		Data:    data,
	})
}

func SuccessMsg(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, Response{
		Code:    0,
		Message: msg,
		Data:    nil,
	})
}

func Error(c *gin.Context, httpStatus int, code int, msg string) {
	c.JSON(httpStatus, Response{
		Code:    code,
		Message: msg,
		Data:    nil,
	})
}

func BadRequest(c *gin.Context, msg string) {
	Error(c, http.StatusBadRequest, 40000, msg)
}

func Unauthorized(c *gin.Context, msg string) {
	Error(c, http.StatusUnauthorized, 40100, msg)
}

func Forbidden(c *gin.Context, msg string) {
	Error(c, http.StatusForbidden, 40300, msg)
}

func NotFound(c *gin.Context, msg string) {
	Error(c, http.StatusNotFound, 40400, msg)
}

func Conflict(c *gin.Context, msg string) {
	Error(c, http.StatusConflict, 40900, msg)
}

func InternalError(c *gin.Context, msg string) {
	Error(c, http.StatusInternalServerError, 50000, msg)
}

type PaginatedData struct {
	Items    interface{} `json:"items"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"page_size"`
}

func SuccessPaginated(c *gin.Context, items interface{}, total int64, page, pageSize int) {
	Success(c, PaginatedData{
		Items:    items,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	})
}
